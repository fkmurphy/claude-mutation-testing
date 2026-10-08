import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REDUCE = fileURLToPath(new URL("../../skills/mutation-testing/scripts/reduce.mjs", import.meta.url));

const at = (line) => ({ start: { line, column: 1 }, end: { line, column: 2 } });
const mutant = (id, status, line, extra = {}) => ({ id, status, mutatorName: "Test", replacement: "x", location: at(line), coveredBy: ["t1"], ...extra });

const reduce = ({ mutants, recheck = "", warnings = "", config, integration }) => {
  const root = mkdtempSync(path.join(tmpdir(), "mutation-reduce-"));
  const report = {
    files: { "src/a.js": { source: "a\nb\nc\nd\ne\n", mutants } },
    testFiles: { "test/a.test.js": { tests: [{ id: "t1", name: "does a" }] } },
  };
  writeFileSync(path.join(root, "mutation.json"), JSON.stringify(report));
  writeFileSync(path.join(root, "recheck.tsv"), recheck);
  writeFileSync(path.join(root, "warnings.txt"), warnings);
  const args = [REDUCE, ...["mutation.json", "recheck.tsv", "warnings.txt"].map((name) => path.join(root, name))];
  if (config) {
    writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
    args.push(path.join(root, "config.json"));
  }
  if (integration) {
    const stageDir = path.join(root, "integration");
    mkdirSync(stageDir);
    const stageReport = {
      files: { "src/a.js": { source: "a\nb\nc\nd\ne\n", mutants: integration.mutants } },
      testFiles: { "test/it/a.test.js": { tests: [{ id: "i1", name: "stores a" }] } },
    };
    writeFileSync(path.join(stageDir, "mutation.json"), JSON.stringify(stageReport));
    writeFileSync(path.join(stageDir, "targets.json"), JSON.stringify(integration.mutants));
    writeFileSync(path.join(stageDir, "recheck.tsv"), integration.recheck ?? "");
    if (!config) {
      writeFileSync(path.join(root, "config.json"), "{}");
      args.push(path.join(root, "config.json"));
    }
    args.push(stageDir);
  }
  const result = spawnSync("node", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

describe("reduce.mjs", () => {
  it("counts statuses and computes both scores", () => {
    const { summary } = reduce({
      mutants: [mutant("1", "Killed", 1), mutant("2", "Survived", 2), mutant("3", "NoCoverage", 3), mutant("4", "Ignored", 4)],
    });
    assert.deepEqual(
      [summary.killed, summary.survived, summary.noCoverage, summary.ignored, summary.scoreOverValid, summary.scoreOverCovered],
      [1, 1, 1, 1, 33.33, 50],
    );
  });

  it("revives a timeout that survives the recheck and counts the inconclusive ones", () => {
    const { summary, survivors } = reduce({
      mutants: [mutant("1", "Timeout", 1), mutant("2", "Timeout", 2), mutant("3", "Timeout", 3)],
      recheck: "1\tSURVIVED\n2\tKILLED\n3\tERROR\n",
    });
    assert.deepEqual(survivors.map(({ id, revivedFromTimeout }) => [id, revivedFromTimeout]), [["1", true]]);
    assert.deepEqual([summary.timeout, summary.timeoutsRechecked, summary.timeoutsInconclusive], [2, 3, 1]);
  });

  it("names the covering tests and the source line of each survivor", () => {
    const { survivors } = reduce({ mutants: [mutant("1", "Survived", 2)] });
    assert.deepEqual([survivors[0].lineText, survivors[0].coveredBy], ["b", ["test/a.test.js › does a"]]);
  });

  it("groups NoCoverage by file and flags kills that came from a broken suite", () => {
    const { noCoverage, suspiciousKills } = reduce({
      mutants: [
        mutant("1", "NoCoverage", 3),
        mutant("2", "NoCoverage", 1),
        mutant("3", "NoCoverage", 3),
        mutant("4", "Killed", 4, { statusReason: "Exceeded timeout of 5000 ms for a hook" }),
      ],
    });
    assert.deepEqual(noCoverage, [{ file: "src/a.js", count: 3, lines: [1, 3] }]);
    assert.deepEqual(suspiciousKills.map(({ id }) => id), ["4"]);
  });

  it("carries warnings and the effective config", () => {
    const result = reduce({ mutants: [], warnings: "LOAD_WARNING: x\n", config: { effective: { concurrency: 4 }, sources: { concurrency: "default" } } });
    assert.deepEqual(result.warnings, ["LOAD_WARNING: x"]);
    assert.deepEqual(result.config, { effective: { concurrency: 4 }, sources: { concurrency: "default" } });
  });
});

describe("reduce.mjs with the integration stage", () => {
  // Stage ids differ from the unit stage's: the position and the change identify the mutant.
  const unit = [mutant("1", "Survived", 1), mutant("2", "Survived", 2), mutant("3", "NoCoverage", 3), mutant("4", "NoCoverage", 4)];
  const stage = [
    mutant("a", "Killed", 1, { killedBy: ["i1"] }),
    mutant("b", "Survived", 2, { coveredBy: ["i1"] }),
    mutant("c", "Survived", 3, { coveredBy: ["i1"] }),
    mutant("d", "NoCoverage", 4),
  ];
  const result = reduce({ mutants: unit, integration: { mutants: stage } });

  it("moves what integration kills out of the survivors, with the test that killed it", () => {
    assert.deepEqual(
      result.killedByIntegration.map(({ id, unitStatus, killedBy }) => [id, unitStatus, killedBy]),
      [["1", "Survived", ["test/it/a.test.js › stores a"]]],
    );
  });

  it("keeps what survives both stages, and adds what only integration covers and does not kill", () => {
    assert.deepEqual(
      result.survivors.map(({ id, integration, unitStatus }) => [id, integration.status, unitStatus ?? null]),
      [
        ["2", "Survived", null],
        ["3", "Survived", "NoCoverage"],
      ],
    );
  });

  it("leaves in noCoverage only what neither stage covers, and scores both stages", () => {
    assert.deepEqual(result.noCoverage, [{ file: "src/a.js", count: 1, lines: [4] }]);
    assert.deepEqual(result.summary.integration, { ran: true, targets: 4, killed: 1, survived: 2 });
    assert.equal(result.summary.scoreWithIntegration, 25);
  });
});
