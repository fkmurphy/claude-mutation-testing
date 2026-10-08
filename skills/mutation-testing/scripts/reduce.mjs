// Reduces Stryker's mutation.json to what needs triage: survivors with their context,
// NoCoverage grouped by file, and kills suspected to come from a flaky suite. With the
// integration stage's directory, mutants it killed leave the survivors for killedByIntegration.
// Usage: node reduce.mjs <mutation.json> [recheck.tsv] [warnings.txt] [config.json] [integration-dir]
//   recheck.tsv: id<TAB>KILLED|SURVIVED|ERROR|TIMEOUT for the timeouts rerun with no load
//   integration-dir: mutation.json and recheck.tsv of the integration stage
import { existsSync, readFileSync } from "node:fs";

const SUSPICIOUS_KILL = /Exceeded timeout|ECONNREFUSED|ECONNRESET|socket hang up|Cannot log after tests are done|SIGSEGV|out of memory/i;
const MAX_TESTS_PER_MUTANT = 5;

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const recheckPath = process.argv[3];
const warningsPath = process.argv[4];
const configPath = process.argv[5];
const configuration = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined;
const integrationDir = process.argv[6];
const warnings = warningsPath && existsSync(warningsPath) ? readFileSync(warningsPath, "utf8").split("\n").filter(Boolean) : [];
const readRecheck = (file) =>
  new Map(
    file && existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"))
      : [],
  );
const recheck = readRecheck(recheckPath);
// A timeout that survives with no load was a hidden survivor.
const statusAfterRecheck = (mutant, rechecked) =>
  mutant.status === "Timeout" && rechecked.get(String(mutant.id)) === "SURVIVED" ? "Survived" : mutant.status;
const effectiveStatus = (mutant) => statusAfterRecheck(mutant, recheck);

const testsOf = (stageReport) =>
  new Map(
    Object.entries(stageReport.testFiles ?? {}).flatMap(([testFile, { tests }]) =>
      tests.map((test) => [test.id, { file: testFile, name: test.name }]),
    ),
  );
const testsById = testsOf(report);
const testNames = (ids, byId) =>
  (ids ?? [])
    .slice(0, MAX_TESTS_PER_MUTANT)
    .map((testId) => byId.get(testId))
    .filter(Boolean)
    .map(({ file, name }) => `${file} › ${name}`);

// The same mutant in both stages: the ids differ, the position and the change do not.
const mutantKey = (file, mutant) =>
  [file, mutant.location.start.line, mutant.location.start.column, mutant.location.end.line, mutant.location.end.column, mutant.mutatorName, mutant.replacement].join("|");

const integrationReportPath = integrationDir && `${integrationDir}/mutation.json`;
const integrationRan = Boolean(integrationReportPath && existsSync(integrationReportPath));
const integrationTargets =
  integrationDir && existsSync(`${integrationDir}/targets.json`) ? JSON.parse(readFileSync(`${integrationDir}/targets.json`, "utf8")).length : 0;
const integrationResults = (() => {
  if (!integrationRan) return new Map();
  const stageReport = JSON.parse(readFileSync(integrationReportPath, "utf8"));
  const stageRecheck = readRecheck(`${integrationDir}/recheck.tsv`);
  const byId = testsOf(stageReport);
  return new Map(
    Object.entries(stageReport.files).flatMap(([file, { mutants: stageMutants }]) =>
      stageMutants.map((mutant) => {
        const status = statusAfterRecheck(mutant, stageRecheck);
        return [mutantKey(file, mutant), { status, killedBy: testNames(mutant.killedBy, byId), coveredBy: testNames(mutant.coveredBy, byId) }];
      }),
    ),
  );
})();
const KILLED_STATUSES = new Set(["Killed", "Timeout"]);

const sliceSource = (lines, { start, end }) =>
  start.line === end.line
    ? lines[start.line - 1].slice(start.column - 1, end.column - 1)
    : [
        lines[start.line - 1].slice(start.column - 1),
        ...lines.slice(start.line, end.line - 1),
        lines[end.line - 1].slice(0, end.column - 1),
      ].join("\n");

const truncate = (text, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text);

const mutants = Object.entries(report.files).flatMap(([file, { source, mutants: fileMutants }]) => {
  const lines = source.split("\n");
  return fileMutants.map((mutant) => ({
    ...mutant,
    status: effectiveStatus(mutant),
    revivedFromTimeout: effectiveStatus(mutant) !== mutant.status,
    file,
    line: mutant.location.start.line,
    lineText: lines[mutant.location.start.line - 1].trim(),
    original: sliceSource(lines, mutant.location),
    integration: integrationResults.get(mutantKey(file, mutant)),
  }));
});

const countBy = (status) => mutants.filter((mutant) => mutant.status === status).length;
const killed = countBy("Killed");
const timeout = countBy("Timeout");
const survived = countBy("Survived");
const noCoverage = countBy("NoCoverage");
const detected = killed + timeout;
const percent = (numerator, denominator) => (denominator === 0 ? null : Math.round((numerator / denominator) * 10000) / 100);

const killedInIntegration = (mutant) => KILLED_STATUSES.has(mutant.integration?.status);
const isSurvivor = (mutant) =>
  (mutant.status === "Survived" && !killedInIntegration(mutant)) || (mutant.status === "NoCoverage" && mutant.integration?.status === "Survived");

const survivors = mutants
  .filter(isSurvivor)
  .map((mutant) => ({
    id: mutant.id,
    file: mutant.file,
    line: mutant.line,
    mutator: mutant.mutatorName,
    original: truncate(mutant.original),
    replacement: truncate(mutant.replacement ?? ""),
    lineText: truncate(mutant.lineText),
    coveredBy: (mutant.coveredBy ?? [])
      .slice(0, MAX_TESTS_PER_MUTANT)
      .map((testId) => testsById.get(testId))
      .filter(Boolean)
      .map(({ file, name }) => `${file} › ${name}`),
    coveredByCount: (mutant.coveredBy ?? []).length,
    ...(mutant.revivedFromTimeout ? { revivedFromTimeout: true } : {}),
    ...(mutant.integration
      ? { integration: { status: mutant.integration.status, coveredBy: mutant.integration.coveredBy }, ...(mutant.status === "NoCoverage" ? { unitStatus: "NoCoverage" } : {}) }
      : {}),
  }));

const killedByIntegration = mutants
  .filter((mutant) => (mutant.status === "Survived" || mutant.status === "NoCoverage") && killedInIntegration(mutant))
  .map((mutant) => ({
    id: mutant.id,
    file: mutant.file,
    line: mutant.line,
    mutator: mutant.mutatorName,
    original: truncate(mutant.original),
    replacement: truncate(mutant.replacement ?? ""),
    unitStatus: mutant.status,
    killedBy: mutant.integration.killedBy,
  }));

const noCoverageByFile = Object.values(
  mutants
    .filter((mutant) => mutant.status === "NoCoverage" && !killedInIntegration(mutant) && mutant.integration?.status !== "Survived")
    .reduce((groups, mutant) => {
      const group = groups[mutant.file] ?? { file: mutant.file, count: 0, lines: new Set() };
      group.count += 1;
      group.lines.add(mutant.line);
      return { ...groups, [mutant.file]: group };
    }, {}),
).map(({ file, count, lines }) => ({ file, count, lines: [...lines].sort((a, b) => a - b) }));

const suspiciousKills = mutants
  .filter((mutant) => mutant.status === "Killed" && SUSPICIOUS_KILL.test(mutant.statusReason ?? ""))
  .map((mutant) => ({
    id: mutant.id,
    file: mutant.file,
    line: mutant.line,
    mutator: mutant.mutatorName,
    reason: truncate(mutant.statusReason, 200),
  }));

console.log(
  JSON.stringify(
    {
      summary: {
        files: Object.keys(report.files).length,
        mutants: mutants.length,
        killed,
        timeout,
        survived,
        noCoverage,
        ignored: countBy("Ignored"),
        compileError: countBy("CompileError"),
        runtimeError: countBy("RuntimeError"),
        scoreOverValid: percent(detected, detected + survived + noCoverage),
        scoreOverCovered: percent(detected, detected + survived),
        suspiciousKills: suspiciousKills.length,
        timeoutsRechecked: recheck.size,
        timeoutsRevived: mutants.filter((mutant) => mutant.revivedFromTimeout).length,
        timeoutsInconclusive: [...recheck.values()].filter((verdict) => verdict !== "KILLED" && verdict !== "SURVIVED").length,
        ...(integrationDir
          ? {
              integration: {
                ran: integrationRan,
                targets: integrationTargets,
                killed: killedByIntegration.length,
                survived: survivors.filter((survivor) => survivor.integration?.status === "Survived").length,
              },
              scoreWithIntegration: percent(detected + killedByIntegration.length, detected + survived + noCoverage),
            }
          : {}),
      },
      warnings,
      ...(configuration ? { config: { effective: configuration.effective, sources: configuration.sources } } : {}),
      survivors,
      ...(integrationDir ? { killedByIntegration } : {}),
      noCoverage: noCoverageByFile,
      suspiciousKills,
    },
    null,
    2,
  ),
);
