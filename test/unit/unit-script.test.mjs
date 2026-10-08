import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findJestInvocation, readJestFlags, tokenize } from "../../skills/mutation-testing/scripts/lib/unit-script.mjs";

describe("tokenize", () => {
  it("keeps quoted values together and drops the quotes", () => {
    assert.deepEqual(tokenize(`jest --a='x y' --b="z"`), ["jest", "--a=x y", "--b=z"]);
  });

  it("splits on a semicolon glued to a word", () => {
    assert.deepEqual(tokenize("a; b"), ["a", ";", "b"]);
  });
});

describe("findJestInvocation", () => {
  it("finds jest called directly, with its environment", () => {
    assert.deepEqual(findJestInvocation("TZ=UTC NODE_ENV=test jest --ci", {}), { env: { TZ: "UTC", NODE_ENV: "test" }, args: ["--ci"] });
  });

  it("follows pnpm run references and appends their arguments", () => {
    const scripts = { "test-runner": "TZ=Etc/UTC jest --setupFilesAfterEnv='./setup.ts'" };
    assert.deepEqual(findJestInvocation("pnpm run test-runner --testPathIgnorePatterns='./it/*'", scripts), {
      env: { TZ: "Etc/UTC" },
      args: ["--setupFilesAfterEnv=./setup.ts", "--testPathIgnorePatterns=./it/*"],
    });
  });

  it("drops the -- that npm needs before forwarded arguments", () => {
    const scripts = { base: "jest" };
    assert.deepEqual(findJestInvocation("npm run base -- --ci", scripts).args, ["--ci"]);
  });

  it("follows yarn without run, npx, pnpm exec and cross-env", () => {
    assert.ok(findJestInvocation("yarn base", { base: "jest" }));
    assert.ok(findJestInvocation("npx jest", {}));
    assert.ok(findJestInvocation("pnpm exec jest", {}));
    assert.deepEqual(findJestInvocation("cross-env TZ=UTC jest", {}).env, { TZ: "UTC" });
  });

  it("looks past other commands chained before jest", () => {
    assert.deepEqual(findJestInvocation("tsc --noEmit && jest --ci", {}).args, ["--ci"]);
  });

  it("returns null when the script never reaches jest, and survives a cycle", () => {
    assert.equal(findJestInvocation("vitest run", {}), null);
    assert.equal(findJestInvocation("pnpm run a", { a: "pnpm run b", b: "pnpm run a" }), null);
  });
});

describe("readJestFlags", () => {
  it("reads --testMatch for the integration suite", () => {
    assert.deepEqual(readJestFlags(["--testMatch=**/it/**/*.test.ts", "--i"]).testMatch, ["**/it/**/*.test.ts"]);
  });

  it("reads both flag forms, kebab-case and repeated flags, without duplicates", () => {
    const flags = readJestFlags([
      "--testPathIgnorePatterns=/a/",
      "--test-path-ignore-patterns",
      "/b/",
      "/c/",
      "--ci",
      "--testPathIgnorePatterns=/a/",
      "--setupFilesAfterEnv",
      "./setup.ts",
      "-c",
      "jest.unit.js",
    ]);
    assert.deepEqual(flags, {
      testPathIgnorePatterns: ["/a/", "/b/", "/c/"],
      setupFilesAfterEnv: ["./setup.ts"],
      testMatch: [],
      config: "jest.unit.js",
    });
  });
});
