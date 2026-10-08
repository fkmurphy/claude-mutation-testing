// Reduces Stryker's mutation.json to what needs triage: survivors with their context,
// NoCoverage grouped by file, and kills suspected to come from a flaky suite.
// Usage: node reduce.mjs <mutation.json> [recheck.tsv] [warnings.txt] [config.json]
//   recheck.tsv: id<TAB>KILLED|SURVIVED for the timeouts rerun with no load
import { existsSync, readFileSync } from "node:fs";

const SUSPICIOUS_KILL = /Exceeded timeout|ECONNREFUSED|ECONNRESET|socket hang up|Cannot log after tests are done|SIGSEGV|out of memory/i;
const MAX_TESTS_PER_MUTANT = 5;

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const recheckPath = process.argv[3];
const warningsPath = process.argv[4];
const configPath = process.argv[5];
const configuration = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined;
const warnings = warningsPath && existsSync(warningsPath) ? readFileSync(warningsPath, "utf8").split("\n").filter(Boolean) : [];
const recheck = new Map(
  recheckPath && existsSync(recheckPath)
    ? readFileSync(recheckPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t"))
    : [],
);
// A timeout that survives with no load was a hidden survivor.
const effectiveStatus = (mutant) =>
  mutant.status === "Timeout" && recheck.get(String(mutant.id)) === "SURVIVED" ? "Survived" : mutant.status;

const testsById = new Map(
  Object.entries(report.testFiles ?? {}).flatMap(([testFile, { tests }]) =>
    tests.map((test) => [test.id, { file: testFile, name: test.name }]),
  ),
);

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
  }));
});

const countBy = (status) => mutants.filter((mutant) => mutant.status === status).length;
const killed = countBy("Killed");
const timeout = countBy("Timeout");
const survived = countBy("Survived");
const noCoverage = countBy("NoCoverage");
const detected = killed + timeout;
const percent = (numerator, denominator) => (denominator === 0 ? null : Math.round((numerator / denominator) * 10000) / 100);

const survivors = mutants
  .filter((mutant) => mutant.status === "Survived")
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
  }));

const noCoverageByFile = Object.values(
  mutants
    .filter((mutant) => mutant.status === "NoCoverage")
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
      },
      warnings,
      ...(configuration ? { config: { effective: configuration.effective, sources: configuration.sources } } : {}),
      survivors,
      noCoverage: noCoverageByFile,
      suspiciousKills,
    },
    null,
    2,
  ),
);
