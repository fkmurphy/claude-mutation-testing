// Resolves the effective configuration of a run: defaults, detected from the repo, then the
// optional <back-dir>/.mutation.json on top. Records where each value came from.
//
// Usage: node resolve-config.mjs <back-dir>
// Output: { effective, sources, report } as JSON on stdout. Exit 2 on a config it cannot use.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_IGNORE_CALLS = ["*logger.*", "this.*logger.*", "getLogger().*", "console.*"];
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REUSE = 20;
const DEFAULT_UNIT_IGNORES = ["/src/test/integration/"];
const DEFAULT_SETUP_FILE = "src/test/globalSetup.ts";
const PACKAGE_MANAGERS = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", npm: "package-lock.json" };
const JEST_CONFIG_FILES = ["jest.config.js", "jest.config.cjs"];
const UNSUPPORTED_JEST_CONFIG_FILES = ["jest.config.mjs", "jest.config.ts", "jest.config.json"];
const KNOWN_KEYS = [
  "ignoreCalls",
  "replaceDefaultIgnoreCalls",
  "unitTestIgnorePatterns",
  "setupFiles",
  "excludedMutations",
  "concurrency",
  "maxTestRunnerReuse",
  "packageManager",
];

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(2);
};

const [backDirArg] = process.argv.slice(2);
if (!backDirArg) fail("usage: node resolve-config.mjs <back-dir>");
const backDir = path.resolve(backDirArg);
const inBackDir = (name) => path.join(backDir, name);

const configPath = inBackDir(".mutation.json");
const userConfig = (() => {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return fail(`.mutation.json is not valid JSON: ${error.message}`);
  }
})();

const unknownKeys = Object.keys(userConfig).filter((key) => !KNOWN_KEYS.includes(key));
if (unknownKeys.length > 0) fail(`.mutation.json has unknown keys: ${unknownKeys.join(", ")}. Known: ${KNOWN_KEYS.join(", ")}`);

const requireType = (key, valid, description) => {
  if (key in userConfig && !valid(userConfig[key])) fail(`.mutation.json: "${key}" must be ${description}`);
};
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
requireType("ignoreCalls", isStringArray, "an array of strings");
requireType("replaceDefaultIgnoreCalls", (value) => typeof value === "boolean", "a boolean");
requireType("unitTestIgnorePatterns", isStringArray, "an array of strings");
requireType("setupFiles", isStringArray, "an array of strings");
requireType("excludedMutations", isStringArray, "an array of strings");
requireType("concurrency", isPositiveInteger, "a positive integer");
requireType("maxTestRunnerReuse", isPositiveInteger, "a positive integer");
requireType("packageManager", (value) => value in PACKAGE_MANAGERS, `one of ${Object.keys(PACKAGE_MANAGERS).join(", ")}`);

const packageJson = existsSync(inBackDir("package.json")) ? JSON.parse(readFileSync(inBackDir("package.json"), "utf8")) : {};

const detectPackageManager = () => {
  if (userConfig.packageManager) return { value: userConfig.packageManager, source: ".mutation.json" };
  const detected = Object.entries(PACKAGE_MANAGERS).find(([, lockfile]) => existsSync(inBackDir(lockfile)));
  if (!detected) return fail('no lockfile found (pnpm-lock.yaml, yarn.lock, package-lock.json): set "packageManager" in .mutation.json');
  return { value: detected[0], source: `detected from ${detected[1]}` };
};

const detectJestConfig = () => {
  const file = JEST_CONFIG_FILES.find((name) => existsSync(inBackDir(name)));
  if (file) return { file, source: "detected" };
  if (packageJson.jest) return { file: null, source: 'detected: "jest" key in package.json' };
  const unsupported = UNSUPPORTED_JEST_CONFIG_FILES.find((name) => existsSync(inBackDir(name)));
  if (unsupported) return fail(`${unsupported} is not supported yet: use jest.config.js, jest.config.cjs or a "jest" key in package.json`);
  return fail("no jest config found (jest.config.js, jest.config.cjs or a \"jest\" key in package.json)");
};

const detectUnitIgnores = () => {
  if (userConfig.unitTestIgnorePatterns) return { value: userConfig.unitTestIgnorePatterns, source: ".mutation.json" };
  const script = packageJson.scripts?.["test-unit"] ?? "";
  const patterns = [...script.matchAll(/--testPathIgnorePatterns[= ]["']?([^"' ]+)/g)].map((match) => match[1]);
  if (patterns.length > 0) return { value: patterns, source: "package.json test-unit script" };
  return { value: DEFAULT_UNIT_IGNORES, source: "default" };
};

const detectSetupFiles = () => {
  if (userConfig.setupFiles) return { value: userConfig.setupFiles, source: ".mutation.json" };
  if (existsSync(inBackDir(DEFAULT_SETUP_FILE))) return { value: [`<rootDir>/${DEFAULT_SETUP_FILE}`], source: `detected ${DEFAULT_SETUP_FILE}` };
  return { value: [], source: "default" };
};

const numberSetting = (envName, key, fallback) => {
  if (process.env[envName]) return { value: Number(process.env[envName]), source: `env ${envName}` };
  if (userConfig[key]) return { value: userConfig[key], source: ".mutation.json" };
  return { value: fallback, source: "default" };
};

const packageManager = detectPackageManager();
const jestConfig = detectJestConfig();
const unitIgnores = detectUnitIgnores();
const setupFiles = detectSetupFiles();
const concurrency = numberSetting("MUTATE_CONCURRENCY", "concurrency", DEFAULT_CONCURRENCY);
const reuse = numberSetting("MUTATE_REUSE", "maxTestRunnerReuse", DEFAULT_REUSE);

const extraIgnoreCalls = userConfig.ignoreCalls ?? [];
const ignoreCalls = userConfig.replaceDefaultIgnoreCalls ? extraIgnoreCalls : [...DEFAULT_IGNORE_CALLS, ...extraIgnoreCalls];
const ignoreCallsSource =
  extraIgnoreCalls.length === 0 && !userConfig.replaceDefaultIgnoreCalls
    ? "default"
    : userConfig.replaceDefaultIgnoreCalls
      ? ".mutation.json (replaces the defaults)"
      : ".mutation.json (added to the defaults)";

const effective = {
  packageManager: packageManager.value,
  lockfile: PACKAGE_MANAGERS[packageManager.value],
  jestConfigFile: jestConfig.file,
  unitTestIgnorePatterns: unitIgnores.value,
  setupFiles: setupFiles.value,
  ignoreCalls,
  excludedMutations: userConfig.excludedMutations ?? [],
  concurrency: concurrency.value,
  maxTestRunnerReuse: reuse.value,
};
const sources = {
  packageManager: packageManager.source,
  jestConfigFile: jestConfig.source,
  unitTestIgnorePatterns: unitIgnores.source,
  setupFiles: setupFiles.source,
  ignoreCalls: ignoreCallsSource,
  excludedMutations: userConfig.excludedMutations ? ".mutation.json" : "default",
  concurrency: concurrency.source,
  maxTestRunnerReuse: reuse.source,
};
const report = Object.keys(sources).map((key) => `${key}: ${JSON.stringify(effective[key])} (${sources[key]})`);

console.log(JSON.stringify({ effective, sources, report }, null, 2));
