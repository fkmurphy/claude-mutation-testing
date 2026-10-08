import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("../../skills/mutation-testing/scripts/probe.mjs", import.meta.url));
const SOURCE = "const answer = 1;\nmodule.exports = answer;\n";

// One mutant: `1` → `2` on line 1.
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mutation-probe-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/answer.js"), SOURCE);
  const report = {
    files: {
      "src/answer.js": {
        source: SOURCE,
        mutants: [{ id: "7", mutatorName: "NumberLiteral", replacement: "2", location: { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } } }],
      },
    },
  };
  writeFileSync(path.join(root, "mutation.json"), JSON.stringify(report));
  return root;
};

const probe = (root, command, env = {}) => {
  const result = spawnSync("node", [PROBE, path.join(root, "mutation.json"), root, "7", "--", ...command], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(readFileSync(path.join(root, "src/answer.js"), "utf8"), SOURCE, "the file is restored");
  return { verdict: result.stdout.split(" ")[0], status: result.status, stdout: result.stdout };
};

const failsWhenMutated = ["node", "-e", "process.exit(require('./src/answer.js') === 2 ? 1 : 0)"];

describe("probe.mjs", () => {
  it("says SURVIVED when the command passes with the mutant", () => {
    assert.deepEqual(probe(setup(), ["node", "-e", ""]).verdict, "SURVIVED");
  });

  it("applies the mutant where the report says", () => {
    const root = setup();
    const { verdict, status } = probe(root, failsWhenMutated);
    assert.deepEqual([verdict, status], ["KILLED", 0]);
  });

  it("says ERROR, not KILLED, when the command also fails without the mutant", () => {
    const { verdict, status, stdout } = probe(setup(), ["node", "-e", "process.exit(1)"]);
    assert.deepEqual([verdict, status], ["ERROR", 3]);
    assert.match(stdout, /also fails without the mutant/);
  });

  it("says ERROR when the command cannot run", () => {
    assert.deepEqual(Object.values(probe(setup(), ["no-such-binary-for-probe"])).slice(0, 2), ["ERROR", 3]);
  });

  it("says TIMEOUT when the command does not finish", () => {
    const { verdict, status } = probe(setup(), ["node", "-e", "setTimeout(() => {}, 5000)"], { PROBE_TIMEOUT_MS: "300" });
    assert.deepEqual([verdict, status], ["TIMEOUT", 4]);
  });

  it("refuses a file that changed since the run", () => {
    const root = setup();
    writeFileSync(path.join(root, "src/answer.js"), `${SOURCE}// edited\n`);
    const result = spawnSync("node", [PROBE, path.join(root, "mutation.json"), root, "7", "--", "node", "-e", ""], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /changed since the Stryker run/);
  });
});
