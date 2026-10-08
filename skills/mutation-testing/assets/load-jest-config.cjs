// Loads the repo's own jest config, in any format jest accepts (.js, .cjs, .mjs, .ts, .json, the
// "jest" key of package.json, a function), through jest-config's readInitialOptions: the same
// loader jest and Stryker use. jest-config is a dependency of jest, so it is resolved through it.
const path = require("node:path");

const resolveFrom = (request, directory) => require.resolve(request, { paths: [directory] });

const loadJestConfigModule = (backDir) => {
  const jestDir = path.dirname(resolveFrom("jest/package.json", backDir));
  const coreDir = path.dirname(resolveFrom("@jest/core/package.json", jestDir));
  return require(resolveFrom("jest-config", coreDir));
};

module.exports = async (backDir, configFile) => {
  const { readInitialOptions } = loadJestConfigModule(backDir);
  if (typeof readInitialOptions !== "function") {
    throw new Error("jest 29.3 or newer is needed: older versions do not expose readInitialOptions");
  }
  const target = configFile ? path.resolve(backDir, configFile) : backDir;
  const { config } = await readInitialOptions(target, { skipMultipleConfigError: true });
  return config;
};
