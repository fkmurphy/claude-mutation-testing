// Applies one mutant from the Stryker report, runs a command and restores the file.
// Settles a survivor: does integration kill it? is it equivalent?
//
// Usage: node probe.mjs <mutation.json> <back-dir> <mutant-id> -- <command> [args...]
// Output: KILLED if the command fails with the mutant applied, SURVIVED if it passes. If the
// command cannot run or runs out of time (PROBE_TIMEOUT_MS, default 10 min) the verdict is ERROR
// or TIMEOUT, exit 3 or 4: that says nothing about the mutant.
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

writeFileSync(filePath, mutated);
let result;
try {
  result = spawnSync(command[0], command.slice(1), {
    cwd: backDir,
    encoding: "utf8",
    env: { ...process.env, TZ: "Etc/UTC" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 10 * 60 * 1000),
  });
} finally {
  restore();
}

if (readFileSync(filePath, "utf8") !== original) {
  console.error(`WARNING: ${found.file} was not restored`);
  process.exit(1);
}

if (result.error?.code === "ETIMEDOUT") {
  console.log(`TIMEOUT · mutant ${mutantId} · ${found.file}:${start.line}: the command did not finish, nothing can be said about the mutant`);
  process.exit(4);
}
if (result.error || result.status === null) {
  console.log(`ERROR · mutant ${mutantId} · ${found.file}:${start.line}: the command could not run (${result.error?.message ?? `signal ${result.signal}`})`);
  process.exit(3);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const summary = output
  .split("\n")
  .filter((line) => /✕|●|Tests:|Test Suites:/.test(line))
  .slice(0, 15)
  .join("\n");

console.log(`${result.status === 0 ? "SURVIVED" : "KILLED"} · mutant ${mutantId} · ${found.file}:${start.line} (${found.mutant.mutatorName})`);
if (summary) console.log(summary);
