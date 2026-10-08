// Gives the calling process one shard (one database name) that no other live process holds.
// Stryker numbers its runners with a counter that keeps growing as runners are recycled, so the
// shard cannot be derived from STRYKER_MUTATOR_WORKER: it is claimed through a lock directory
// instead. A lock whose process is gone is taken over.
const { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const POLL_MS = 250;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const ownerOf = (lock) => {
  try {
    return Number(readFileSync(path.join(lock, "pid"), "utf8"));
  } catch {
    return null;
  }
};

const tryClaim = (lock, retakeStale = true) => {
  try {
    mkdirSync(lock);
  } catch {
    const owner = ownerOf(lock);
    // A lock without a pid is being written right now: it belongs to someone alive.
    if (!retakeStale || owner === null || isAlive(owner)) return false;
    rmSync(lock, { recursive: true, force: true });
    return tryClaim(lock, false);
  }
  writeFileSync(path.join(lock, "pid"), String(process.pid));
  process.on("exit", () => rmSync(lock, { recursive: true, force: true }));
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async ({ names, locksDir, waitMs = 10 * 60 * 1000 }) => {
  mkdirSync(locksDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  const attempt = async () => {
    const name = names.find((candidate) => tryClaim(path.join(locksDir, `${candidate}.lock`)));
    if (name) {
      appendFileSync(path.join(locksDir, "claims.log"), `${name}\t${process.pid}\n`);
      return name;
    }
    if (Date.now() > deadline) throw new Error(`no free shard among ${names.length} after ${waitMs} ms`);
    await sleep(POLL_MS);
    return attempt();
  };
  return attempt();
};
