// A stand-in for a database server: one directory per database, shared by every process on the
// machine, named by FIXTURE_DB. Tests that clean it would wipe each other's data if two runners
// used the same one, which is what the integration stage's shards prevent.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const databaseDir = () => path.join(os.tmpdir(), "mutation-fixture-db", process.env.FIXTURE_DB ?? "fixture");

function cleanDb() {
  const dir = databaseDir();
  if (!fs.existsSync(dir)) throw new Error(`database ${path.basename(dir)} does not exist`);
  fs.readdirSync(dir).forEach((file) => fs.rmSync(path.join(dir, file)));
}

function insertCustomer(customer) {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(databaseDir(), `${id}.json`), JSON.stringify(customer));
}

function allCustomers() {
  const dir = databaseDir();
  return fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
}

module.exports = { cleanDb, insertCustomer, allCustomers };
