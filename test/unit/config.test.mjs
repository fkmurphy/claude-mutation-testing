import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONFIG_KEYS,
  ConfigError,
  DEFAULT_IGNORE_CALLS,
  DEFAULT_UNIT_TEST_IGNORE_PATTERNS,
  resolveConfig,
} from "../../skills/mutation-testing/scripts/lib/config.mjs";

const project = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), "mutation-config-"));
  mkdirSync(path.join(root, ".git"));
  Object.entries(files).forEach(([name, content]) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), typeof content === "string" ? content : JSON.stringify(content));
  });
  return root;
};

const resolve = (files, directory = ".", env = {}) => resolveConfig(path.join(project(files), directory), env);

describe("package manager", () => {
  it("takes the closest lockfile, looking up to the repo root", () => {
    const files = { "pnpm-lock.yaml": "", "svc/package.json": {}, "svc/yarn.lock": "" };
    assert.equal(resolve(files, "svc").effective.packageManager, "yarn");
    const workspace = resolve({ "pnpm-lock.yaml": "", "svc/package.json": {} }, "svc");
    assert.deepEqual([workspace.effective.packageManager, workspace.effective.lockfile], ["pnpm", "../pnpm-lock.yaml"]);
  });

  it("falls back to the packageManager field, then to npm", () => {
    assert.equal(resolve({ "package.json": { packageManager: "yarn@1.22.22" } }).effective.packageManager, "yarn");
    assert.equal(resolve({ "package.json": {} }).sources.packageManager, "default: no lockfile found");
  });
});

describe("unit test script", () => {
  const scripts = {
    "test-runner": "TZ=Etc/UTC jest --setupFilesAfterEnv='./src/test/setup.ts'",
    "test-unit": "pnpm run test-runner --testPathIgnorePatterns='./src/test/integration/*'",
  };

  it("derives ignore patterns, setup files and environment from the script and its references", () => {
    const { effective, sources } = resolve({ "package.json": { scripts } });
    assert.deepEqual(effective.unitTestIgnorePatterns, ["./src/test/integration/*"]);
    assert.deepEqual(effective.setupFilesAfterEnv, ["./src/test/setup.ts"]);
    assert.deepEqual(effective.env, { TZ: "Etc/UTC" });
    assert.equal(sources.unitTestIgnorePatterns, '"test-unit" script');
  });

  it("uses the generic defaults without a unit script", () => {
    const { effective } = resolve({ "package.json": { scripts: { test: "jest" } } });
    assert.deepEqual(effective.unitTestIgnorePatterns, DEFAULT_UNIT_TEST_IGNORE_PATTERNS);
    assert.equal(effective.unitTestScript, null);
  });

  it("says so when the unit script does not run jest", () => {
    const { sources } = resolve({ "package.json": { scripts: { "test:unit": "vitest run" } } });
    assert.equal(sources.unitTestIgnorePatterns, 'default: "test:unit" does not run jest');
  });

  it("takes the jest config from the script's --config", () => {
    assert.equal(resolve({ "package.json": { scripts: { unit: "jest -c jest.unit.js" } } }).effective.jestConfig, "jest.unit.js");
  });

  it("lets .mutation.json override each derived value", () => {
    const { effective } = resolve({
      "package.json": { scripts },
      ".mutation.json": { unitTestIgnorePatterns: ["/slow/"], setupFilesAfterEnv: [], env: { TZ: "UTC" } },
    });
    assert.deepEqual([effective.unitTestIgnorePatterns, effective.setupFilesAfterEnv, effective.env], [["/slow/"], [], { TZ: "UTC" }]);
  });
});

describe("jest config", () => {
  it("detects every format jest reads", () => {
    assert.equal(resolve({ "package.json": {}, "jest.config.ts": "" }).effective.jestConfig, "jest.config.ts");
    assert.equal(resolve({ "package.json": { jest: {} } }).effective.jestConfig, "package.json");
    assert.equal(resolve({ "package.json": {} }).effective.jestConfig, null);
  });
});

describe("ignoreCalls", () => {
  it("adds to the defaults unless told to replace them", () => {
    assert.deepEqual(resolve({ "package.json": {}, ".mutation.json": { ignoreCalls: ["audit.*"] } }).effective.ignoreCalls, [
      ...DEFAULT_IGNORE_CALLS,
      "audit.*",
    ]);
    const replaced = resolve({ "package.json": {}, ".mutation.json": { ignoreCalls: ["audit.*"], replaceDefaultIgnoreCalls: true } });
    assert.deepEqual(replaced.effective.ignoreCalls, ["audit.*"]);
  });
});

describe("validation", () => {
  const rejects = (files, message, env) => assert.throws(() => resolve(files, ".", env), (error) => error instanceof ConfigError && message.test(error.message));

  it("rejects unknown keys, wrong types and inherited names", () => {
    rejects({ "package.json": {}, ".mutation.json": { setupFiles: [] } }, /unknown key: setupFiles/);
    rejects({ "package.json": {}, ".mutation.json": { concurrency: 0 } }, /"concurrency" must be a positive integer/);
    rejects({ "package.json": {}, ".mutation.json": { packageManager: "constructor" } }, /"packageManager" must be one of/);
    rejects({ "package.json": {}, ".mutation.json": { env: { TZ: 1 } } }, /"env" must be an object of string values/);
    rejects({ "package.json": {}, ".mutation.json": [] }, /must be a JSON object/);
    rejects({ "package.json": {}, ".mutation.json": "{" }, /not valid JSON/);
  });

  it("rejects a unitTestScript that does not exist", () => {
    rejects({ "package.json": {}, ".mutation.json": { unitTestScript: "nope" } }, /"nope" is not a script/);
  });

  it("accepts $schema", () => {
    assert.ok(resolve({ "package.json": {}, ".mutation.json": { $schema: "./mutation.schema.json" } }));
  });

  it("validates the environment overrides and lets them win", () => {
    rejects({ "package.json": {} }, /MUTATE_CONCURRENCY must be a positive integer/, { MUTATE_CONCURRENCY: "abc" });
    const { effective, sources } = resolve({ "package.json": {}, ".mutation.json": { concurrency: 2 } }, ".", { MUTATE_CONCURRENCY: "6" });
    assert.deepEqual([effective.concurrency, sources.concurrency], [6, "env MUTATE_CONCURRENCY"]);
  });

  it("fails without a package.json", () => {
    rejects({}, /has no package.json/);
  });
});

describe("integration", () => {
  const scripts = {
    "test-runner": "TZ=Etc/UTC jest --setupFilesAfterEnv='./src/test/setup.ts'",
    "test-integration": "pnpm run test-runner --i --setupFilesAfterEnv='./src/test/integration/setup.ts' --testMatch='**/src/test/integration/**/*.test.ts'",
  };
  const database = { env: "DB_NAME", template: "app_test", prepare: "createdb -T \"$MUTATION_DB_TEMPLATE\" \"$MUTATION_DB\"" };

  it("derives the integration suite from its script", () => {
    const { effective } = resolve({ "package.json": { scripts } });
    assert.deepEqual(effective.integration, {
      testScript: "test-integration",
      testMatch: ["**/src/test/integration/**/*.test.ts"],
      setupFilesAfterEnv: ["./src/test/setup.ts", "./src/test/integration/setup.ts"],
      env: { TZ: "Etc/UTC" },
      concurrency: 1,
      database: null,
    });
  });

  it("runs one shard per runner only with a database to give each", () => {
    assert.equal(resolve({ "package.json": { scripts }, ".mutation.json": { integration: { database } } }).effective.integration.concurrency, 2);
    const configured = resolve({ "package.json": { scripts }, ".mutation.json": { integration: { database, concurrency: 3 } } });
    assert.equal(configured.effective.integration.concurrency, 3);
  });

  it("validates the nested sections", () => {
    const rejects = (integration, message) =>
      assert.throws(() => resolve({ "package.json": { scripts }, ".mutation.json": { integration } }), (error) => message.test(error.message));
    rejects({ shards: 2 }, /unknown key: integration.shards/);
    rejects({ database: { env: "DB_NAME", template: "app_test" } }, /"integration.database.prepare" is required/);
    rejects({ database: { ...database, env: "" } }, /"integration.database.env" must be/);
    rejects({ testScript: "nope" }, /integration.testScript "nope" is not a script/);
  });
});

describe("schema/mutation.schema.json", () => {
  it("documents exactly the keys the validator accepts", () => {
    const schema = JSON.parse(readFileSync(new URL("../../schema/mutation.schema.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(schema.properties).sort(), [...CONFIG_KEYS].sort());
  });
});
