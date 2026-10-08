import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAIM = fileURLToPath(new URL("../../skills/mutation-testing/assets/claim-shard.cjs", import.meta.url));

// A process that claims a shard, prints it, and holds it for a while.
const claimer = (locksDir, names, holdMs) =>
  new Promise((resolve, reject) => {
    const script = `require(${JSON.stringify(CLAIM)})({ names: ${JSON.stringify(names)}, locksDir: ${JSON.stringify(locksDir)}, waitMs: 5000 })
      .then((name) => { console.log(name); setTimeout(() => {}, ${holdMs}); })
      .catch((error) => { console.error(error.message); process.exit(1); });`;
    const child = spawn(process.execPath, ["-e", script]);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`exit ${code}`))));
  });

describe("claim-shard.cjs", () => {
  it("never gives the same shard to two live processes", async () => {
    const locksDir = mkdtempSync(path.join(tmpdir(), "mutation-shards-"));
    const claimed = await Promise.all([1, 2, 3].map(() => claimer(locksDir, ["db_0", "db_1", "db_2"], 400)));
    assert.deepEqual([...claimed].sort(), ["db_0", "db_1", "db_2"]);
  });

  it("waits for a shard to be released when all are taken", async () => {
    const locksDir = mkdtempSync(path.join(tmpdir(), "mutation-shards-"));
    const claimed = await Promise.all([claimer(locksDir, ["db_0"], 300), claimer(locksDir, ["db_0"], 0)]);
    assert.deepEqual(claimed, ["db_0", "db_0"]);
  });

  it("takes over a lock whose process is gone", async () => {
    const locksDir = mkdtempSync(path.join(tmpdir(), "mutation-shards-"));
    mkdirSync(path.join(locksDir, "db_0.lock"));
    writeFileSync(path.join(locksDir, "db_0.lock", "pid"), "999999");
    assert.equal(await claimer(locksDir, ["db_0"], 0), "db_0");
  });
});
