// The jest config a stage runs with: the repo's own, plus what the stage adds. The stage writes
// its settings to a JSON file next to this one and points jest at a two-line file that calls
// this. Paths resolve from where the file is loaded: inside Stryker's sandbox they point to the
// sandbox copy, so setup files import the mutated code and not the original.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const claimShard = require("./claim-shard.cjs");
const loadJestConfig = require("./load-jest-config.cjs");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = (workDir, settingsFile) => async () => {
  const backDir = path.resolve(workDir, "..");
  const settings = JSON.parse(readFileSync(path.join(workDir, settingsFile), "utf8"));
  const toPath = (file) => (file.startsWith("<rootDir>") ? file : path.resolve(backDir, file));

  // Set before any test module loads, so the app reads its own shard's database name.
  if (settings.shard) process.env[settings.shard.env] = await claimShard(settings.shard);

  const base = await loadJestConfig(backDir, settings.jestConfig);
  // Only the selected files run: every other path is ignored, whatever testMatch says.
  const onlySelected = settings.selectedTests
    ? [`^(?!(?:${settings.selectedTests.map((file) => escapeRegExp(path.resolve(backDir, file))).join("|")})$)`]
    : [];
  return {
    ...base,
    ...(settings.testMatch ? { testMatch: settings.testMatch } : {}),
    setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), ...settings.setupFilesAfterEnv.map(toPath)],
    testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? ["/node_modules/"]), ...settings.testPathIgnorePatterns, ...onlySelected],
  };
};
