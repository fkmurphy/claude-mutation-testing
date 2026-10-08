// The integration stage of mutate.sh --integration. The unit stage already ran every mutant; this
// one takes only what it left alive (survivors and NoCoverage), mutates exactly those positions
// again, and runs against them the integration tests that reach their lines. Every Stryker runner
// is a shard with a database of its own, so tests that clean tables never share data.
//
// Usage: node integration-stage.mjs <out-dir> <back-dir> <work-dir> <skill-dir>
// Writes <out-dir>/integration/{mutation.json,recheck.tsv,...} and appends to warnings.txt.
// Exit 0 also when the stage is skipped: the unit result stands on its own, and the reason is a
// warning. Exit 1 only on an unexpected failure.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [outDir, backDir, workDir, skillDir] = process.argv.slice(2);
const stageDir = path.join(outDir, "integration");
mkdirSync(stageDir, { recursive: true });

const { effective } = JSON.parse(readFileSync(path.join(outDir, "config.json"), "utf8"));
const integration = effective.integration;
const report = JSON.parse(readFileSync(path.join(outDir, "mutation.json"), "utf8"));
const recheck = new Map(
  existsSync(path.join(outDir, "recheck.tsv"))
    ? readFileSync(path.join(outDir, "recheck.tsv"), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"))
    : [],
);

const log = (message) => process.stderr.write(`${message}\n`);
const warn = (code, message) => {
  const line = `${code}: ${message}`;
  appendFileSync(path.join(outDir, "warnings.txt"), `${line}\n`);
  log(line);
};
const skip = (code, message) => {
  warn(code, `${message} The integration stage was skipped; the unit result stands.`);
  process.exit(0);
};

const stageEnv = { ...process.env, ...integration.env };
const run = (command, args, { env = stageEnv, logFile, timeout } = {}) => {
  const result = spawnSync(command, args, { cwd: backDir, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout });
  if (logFile) writeFileSync(logFile, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
};
const failureLines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => /✕|●|Tests:/.test(line))
    .slice(0, 10)
    .join("\n");

// What the unit stage left alive: survivors (including timeouts revived by the recheck) and
// NoCoverage. The key identifies the same mutant across both runs, whose ids differ.
const mutantKey = (file, mutant) =>
  [file, mutant.location.start.line, mutant.location.start.column, mutant.location.end.line, mutant.location.end.column, mutant.mutatorName, mutant.replacement].join("|");

const targets = Object.entries(report.files).flatMap(([file, { mutants }]) =>
  mutants
    .filter(
      (mutant) => mutant.status === "Survived" || mutant.status === "NoCoverage" || (mutant.status === "Timeout" && recheck.get(String(mutant.id)) === "SURVIVED"),
    )
    .map((mutant) => ({ id: mutant.id, file, location: mutant.location, key: mutantKey(file, mutant) })),
);
if (targets.length === 0) {
  log("integration stage: the unit stage left nothing alive, nothing to settle");
  writeFileSync(path.join(stageDir, "targets.json"), "[]");
  process.exit(0);
}
writeFileSync(path.join(stageDir, "targets.json"), JSON.stringify(targets, null, 2));

// Stryker ranges: line from 1, column from 0, both ends included. The end column is widened by
// one so the mutant's last character is inside; neighbours that fall in the range are dropped
// when the results are matched by key.
const ranges = [
  ...new Set(
    targets.map(({ file, location: { start, end } }) => `${file}:${start.line}:${start.column - 1}-${end.line}:${end.column}`),
  ),
];
const lineSpecs = [...new Set(targets.map(({ file, location: { start, end } }) => `${file}:${start.line}-${end.line}`))];

log(`integration stage: ${targets.length} mutant(s) left alive by the unit stage, selecting the tests that reach them...`);
const selector = run("node", [path.join(skillDir, "scripts/affected-tests.mjs"), backDir, ...lineSpecs], {
  logFile: path.join(stageDir, "affected-tests.log"),
});
if (selector.status !== 0) skip("INTEGRATION_SKIPPED", `affected-tests could not run (needs typescript and a tsconfig.json), see ${stageDir}/affected-tests.log.`);
const affected = JSON.parse(selector.stdout);
writeFileSync(path.join(stageDir, "affected-tests.json"), JSON.stringify(affected, null, 2));
const selectedTests = affected.tests.map(({ file }) => file);
if (affected.hubs.length > 0 || affected.roots.length > 0 || affected.stats.truncated) {
  warn(
    "SELECTOR_INCOMPLETE",
    `the static walk stopped at ${affected.hubs.length} shared method(s) and ${affected.roots.length} module-level reference(s)${affected.stats.truncated ? ", and hit its node limit" : ""}: tests reached only through them are not run (see ${stageDir}/affected-tests.json).`,
  );
}
if (selectedTests.length === 0) skip("INTEGRATION_NO_TESTS", "no test reaches the lines left alive.");

// Shards: one database per runner, copied from the template by the repo's own command.
const shardNames = integration.database
  ? Array.from({ length: integration.concurrency }, (_, index) => `${integration.database.template}_mutation_${index}`)
  : [];
const prepareShard = (name) =>
  run("sh", ["-c", integration.database.prepare], {
    env: { ...stageEnv, MUTATION_DB: name, MUTATION_DB_TEMPLATE: integration.database.template },
    logFile: path.join(stageDir, `prepare-${name}.log`),
  });
const dropShards = () =>
  shardNames.forEach((name) =>
    run("sh", ["-c", integration.database.drop], {
      env: { ...stageEnv, MUTATION_DB: name, MUTATION_DB_TEMPLATE: integration.database.template },
      logFile: path.join(stageDir, `drop-${name}.log`),
    }),
  );
if (integration.database) {
  // Dropped on every way out, skipped stage included; without a drop command they are kept.
  if (integration.database.drop) process.on("exit", dropShards);
  log(`integration stage: preparing ${shardNames.length} shard database(s) from ${integration.database.template}...`);
  const failed = shardNames.find((name) => prepareShard(name).status !== 0);
  if (failed) skip("INTEGRATION_SKIPPED", `integration.database.prepare failed for ${failed}, see ${stageDir}/prepare-${failed}.log.`);
}

const settings = {
  jestConfig: effective.jestConfig,
  setupFilesAfterEnv: integration.setupFilesAfterEnv,
  testPathIgnorePatterns: [],
  testMatch: integration.testMatch.length > 0 ? integration.testMatch : null,
  selectedTests,
  shard: integration.database ? { env: integration.database.env, names: shardNames, locksDir: path.join(stageDir, "shard-locks") } : null,
};
writeFileSync(path.join(workDir, "integration.json"), JSON.stringify(settings, null, 2));
writeFileSync(path.join(workDir, "jest.integration.cjs"), 'module.exports = require("./jest-config.cjs")(__dirname, "integration.json");\n');
const jestBin = path.join(backDir, "node_modules/.bin/jest");
const jestArgs = ["-c", path.join(workDir, "jest.integration.cjs"), "--runInBand", "--silent"];

log("integration stage: baseline of the selected integration tests...");
const baselineLog = path.join(stageDir, "baseline.log");
const baselineStart = Date.now();
const baseline = run(jestBin, [...jestArgs, "--passWithNoTests"], { logFile: baselineLog });
const baselineSeconds = Math.round((Date.now() - baselineStart) / 1000);
if (baseline.status !== 0) skip("INTEGRATION_BASELINE_RED", `the selected integration tests fail without any mutation:\n${failureLines(baselineLog)}\n`);
if (/No tests found/.test(readFileSync(baselineLog, "utf8"))) {
  skip("INTEGRATION_NO_TESTS", "none of the tests that reach the lines is an integration test (integration.testMatch).");
}

const strykerConfig = {
  packageManager: effective.packageManager,
  testRunner: "jest",
  plugins: ["@stryker-mutator/jest-runner"],
  appendPlugins: [`./${path.basename(workDir)}/log-ignorer.mjs`],
  ignorers: ["log-calls"],
  jest: { projectType: "custom", configFile: `${path.basename(workDir)}/jest.integration.cjs`, enableFindRelatedTests: false },
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  concurrency: integration.concurrency,
  maxTestRunnerReuse: effective.maxTestRunnerReuse,
  mutate: ranges,
  ...(effective.excludedMutations.length > 0 ? { mutator: { excludedMutations: effective.excludedMutations } } : {}),
  reporters: ["json"],
  jsonReporter: { fileName: path.join(stageDir, "mutation.json") },
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  incremental: false,
  thresholds: { high: 80, low: 60, break: null },
};
writeFileSync(path.join(workDir, "stryker.integration.json"), JSON.stringify(strykerConfig, null, 2));

log(`integration stage: running Stryker on ${ranges.length} position(s) with ${integration.concurrency} shard(s), ${selectedTests.length} test file(s) selected...`);
const strykerStart = Date.now();
const stryker = run(path.join(backDir, "node_modules/.bin/stryker"), ["run", path.join(workDir, "stryker.integration.json")], {
  logFile: path.join(stageDir, "stryker.log"),
});
if (stryker.status !== 0) {
  const tail = readFileSync(path.join(stageDir, "stryker.log"), "utf8").split("\n").slice(-15).join("\n");
  skip("INTEGRATION_FAILED", `Stryker failed in the integration stage:\n${tail}\n`);
}
log(`integration stage: Stryker took ${Math.round((Date.now() - strykerStart) / 1000)}s`);

// Same recheck as the unit stage: a timeout under load can hide a survivor. One shard is free
// for each recheck now that Stryker is done.
const stageReport = JSON.parse(readFileSync(path.join(stageDir, "mutation.json"), "utf8"));
const testFileById = new Map(Object.entries(stageReport.testFiles ?? {}).flatMap(([file, { tests }]) => tests.map((test) => [test.id, file])));
const targetKeys = new Set(targets.map(({ key }) => key));
const timeouts = Object.entries(stageReport.files).flatMap(([file, { mutants }]) =>
  mutants.filter((mutant) => targetKeys.has(mutantKey(file, mutant)) && mutant.status === "Timeout" && !/Hit limit/i.test(mutant.statusReason ?? "")),
);
const recheckTimeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? (baselineSeconds * 3 + 60) * 1000);
const recheckLines = timeouts.map((mutant) => {
  const testFiles = [...new Set((mutant.coveredBy ?? []).map((id) => testFileById.get(id)).filter(Boolean))];
  if (testFiles.length === 0) return `${mutant.id}\tTIMEOUT`;
  const probe = run(
    "node",
    [path.join(skillDir, "scripts/probe.mjs"), path.join(stageDir, "mutation.json"), backDir, String(mutant.id), "--", jestBin, ...jestArgs, ...testFiles],
    { env: { ...stageEnv, PROBE_TIMEOUT_MS: String(recheckTimeoutMs) } },
  );
  const firstLine = (probe.stdout ?? "").split("\n")[0];
  const verdict = firstLine.split(" ")[0] || "ERROR";
  if (verdict !== "KILLED" && verdict !== "SURVIVED") warn("RECHECK_INCONCLUSIVE", `${firstLine || `mutant ${mutant.id}: probe printed nothing`}. It stays counted as a timeout.`);
  return `${mutant.id}\t${verdict}`;
});
if (timeouts.length > 0) log(`integration stage: rechecked ${timeouts.length} timeout(s) with no load`);
writeFileSync(path.join(stageDir, "recheck.tsv"), recheckLines.map((line) => `${line}\n`).join(""));

