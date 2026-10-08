// Applies one mutant from the Stryker report, runs a command and restores the file.
// Settles a survivor: does integration kill it? is it equivalent?
//
// Usage: node probe.mjs <mutation.json> <back-dir> <mutant-id> -- <command> [args...]
// Output: KILLED if the command fails with the mutant applied and passes without it, SURVIVED if
// it passes with the mutant. A failure is always confirmed by running the command again without
// the mutant: if it fails there too (a database that is down, a red test) the verdict is ERROR.
// ERROR (exit 3) and TIMEOUT (exit 4, PROBE_TIMEOUT_MS, default 10 min) say nothing about the mutant.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [reportPath, backDir, mutantId, separator, ...command] = process.argv.slice(2);
if (separator !== "--" || command.length === 0) {
  console.error("usage: node probe.mjs <mutation.json> <back-dir> <mutant-id> -- <command> [args...]");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const found = Object.entries(report.files)
  .flatMap(([file, { source, mutants }]) => mutants.map((mutant) => ({ file, source, mutant })))
  .find(({ mutant }) => String(mutant.id) === String(mutantId));
if (!found) {
  console.error(`no mutant ${mutantId} in the report`);
  process.exit(2);
}

const filePath = resolve(backDir, found.file);
const original = readFileSync(filePath, "utf8");
if (original !== found.source) {
  console.error(`${found.file} changed since the Stryker run: the mutant cannot be applied`);
  process.exit(2);
}

const lineStarts = original.split("\n").reduce((starts, line) => [...starts, starts.at(-1) + line.length + 1], [0]);
const offset = ({ line, column }) => lineStarts[line - 1] + column - 1;
const { start, end } = found.mutant.location;
const mutated = original.slice(0, offset(start)) + found.mutant.replacement + original.slice(offset(end));

const restore = () => writeFileSync(filePath, original);
["SIGINT", "SIGTERM"].forEach((signal) =>
  process.on(signal, () => {
    restore();
    process.exit(130);
  }),
);

const run = () =>
  spawnSync(command[0], command.slice(1), {
    cwd: backDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 10 * 60 * 1000),
  });

const failureSummary = (result) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /✕|●|Tests:|Test Suites:/.test(line))
    .slice(0, 15)
    .join("\n");

const where = `mutant ${mutantId} · ${found.file}:${start.line}`;

const exitIfNotConclusive = (result, label) => {
  if (result.error?.code === "ETIMEDOUT") {
    console.log(`TIMEOUT · ${where}: the command did not finish ${label}, nothing can be said about the mutant`);
    process.exit(4);
  }
  if (result.error || result.status === null) {
    console.log(`ERROR · ${where}: the command could not run ${label} (${result.error?.message ?? `signal ${result.signal}`})`);
    process.exit(3);
  }
};

writeFileSync(filePath, mutated);
let mutatedResult;
try {
  mutatedResult = run();
} finally {
  restore();
}

if (readFileSync(filePath, "utf8") !== original) {
  console.error(`WARNING: ${found.file} was not restored`);
  process.exit(1);
}

exitIfNotConclusive(mutatedResult, "with the mutant");

if (mutatedResult.status === 0) {
  console.log(`SURVIVED · ${where} (${found.mutant.mutatorName})`);
  process.exit(0);
}

const baselineResult = run();
exitIfNotConclusive(baselineResult, "without the mutant");
if (baselineResult.status !== 0) {
  console.log(`ERROR · ${where}: the command also fails without the mutant, so its failure says nothing about the mutant`);
  const baselineSummary = failureSummary(baselineResult);
  if (baselineSummary) console.log(baselineSummary);
  process.exit(3);
}

console.log(`KILLED · ${where} (${found.mutant.mutatorName})`);
const summary = failureSummary(mutatedResult);
if (summary) console.log(summary);
