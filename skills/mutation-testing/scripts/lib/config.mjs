// Resolves the effective configuration of a run: defaults, what can be read from the repo, then
// the optional <back-dir>/.mutation.json on top. Records where each value came from.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findJestInvocation, readJestFlags } from "./unit-script.mjs";

const LOG_METHODS = "{info,warn,error,debug,trace,fatal,child}";
export const DEFAULT_IGNORE_CALLS = [
  `*logger.${LOG_METHODS}`,
  `this.*logger.${LOG_METHODS}`,
  `*logger.child().${LOG_METHODS}`,
  `this.*logger.child().${LOG_METHODS}`,
  `getLogger().${LOG_METHODS}`,
  "console.*",
];
export const DEFAULT_UNIT_TEST_IGNORE_PATTERNS = ["/integration/", "/e2e/"];
const DEFAULT_UNIT_TEST_SCRIPTS = ["test-unit", "test:unit", "unit"];
const DEFAULT_INTEGRATION_TEST_SCRIPTS = ["test-integration", "test:integration", "integration"];
const DEFAULT_INTEGRATION_CONCURRENCY = 2;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REUSE = 20;
const PACKAGE_MANAGERS = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", npm: "package-lock.json" };
const JEST_CONFIG_FILES = ["js", "cjs", "mjs", "ts", "cts", "mts", "json"].map((extension) => `jest.config.${extension}`);

const SCHEMA = {
  $schema: { valid: (value) => typeof value === "string", description: "a string" },
  unitTestScript: { valid: (value) => typeof value === "string" && value.length > 0, description: "a script name" },
  ignoreCalls: { valid: (value) => isStringArray(value), description: "an array of strings" },
  replaceDefaultIgnoreCalls: { valid: (value) => typeof value === "boolean", description: "a boolean" },
  unitTestIgnorePatterns: { valid: (value) => isStringArray(value), description: "an array of strings" },
  setupFilesAfterEnv: { valid: (value) => isStringArray(value), description: "an array of strings" },
  env: { valid: (value) => isStringRecord(value), description: "an object of string values" },
  excludedMutations: { valid: (value) => isStringArray(value), description: "an array of strings" },
  concurrency: { valid: (value) => isPositiveInteger(value), description: "a positive integer" },
  maxTestRunnerReuse: { valid: (value) => isPositiveInteger(value), description: "a positive integer" },
  packageManager: {
    valid: (value) => typeof value === "string" && Object.hasOwn(PACKAGE_MANAGERS, value),
    description: `one of ${Object.keys(PACKAGE_MANAGERS).join(", ")}`,
  },
  integration: { valid: (value) => isPlainObject(value), description: "an object" },
};

const INTEGRATION_SCHEMA = {
  testScript: SCHEMA.unitTestScript,
  testMatch: SCHEMA.unitTestIgnorePatterns,
  setupFilesAfterEnv: SCHEMA.setupFilesAfterEnv,
  env: SCHEMA.env,
  concurrency: SCHEMA.concurrency,
  database: { valid: (value) => isPlainObject(value), description: "an object" },
};

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const DATABASE_SCHEMA = {
  env: { valid: isNonEmptyString, description: "the name of the variable that holds the database name", required: true },
  template: { valid: isNonEmptyString, description: "the database every shard is created from", required: true },
  prepare: { valid: isNonEmptyString, description: "a shell command that creates $MUTATION_DB from $MUTATION_DB_TEMPLATE", required: true },
  drop: { valid: isNonEmptyString, description: "a shell command that drops $MUTATION_DB" },
};

export const CONFIG_KEYS = Object.keys(SCHEMA);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isStringRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

export class ConfigError extends Error {}

const readJson = (file, label) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${error.message}`);
  }
};

const validateSection = (section, schema, prefix) => {
  const unknownKey = Object.keys(section).find((key) => !Object.hasOwn(schema, key));
  if (unknownKey) throw new ConfigError(`.mutation.json has an unknown key: ${prefix}${unknownKey}. Known: ${Object.keys(schema).map((key) => prefix + key).join(", ")}`);
  const invalidKey = Object.keys(section).find((key) => !schema[key].valid(section[key]));
  if (invalidKey) throw new ConfigError(`.mutation.json: "${prefix}${invalidKey}" must be ${schema[invalidKey].description}`);
  const missingKey = Object.keys(schema).find((key) => schema[key].required && section[key] === undefined);
  if (missingKey) throw new ConfigError(`.mutation.json: "${prefix}${missingKey}" is required: ${schema[missingKey].description}`);
};

const readUserConfig = (backDir) => {
  const file = path.join(backDir, ".mutation.json");
  if (!existsSync(file)) return {};
  const userConfig = readJson(file, ".mutation.json");
  if (userConfig === null || typeof userConfig !== "object" || Array.isArray(userConfig)) {
    throw new ConfigError(".mutation.json must be a JSON object");
  }
  validateSection(userConfig, SCHEMA, "");
  if (userConfig.integration) validateSection(userConfig.integration, INTEGRATION_SCHEMA, "integration.");
  if (userConfig.integration?.database) validateSection(userConfig.integration.database, DATABASE_SCHEMA, "integration.database.");
  return userConfig;
};

// Workspaces keep the lockfile at the root, so the search goes up to the repo root.
const ancestorsUpToRepoRoot = (directory) => {
  const parent = path.dirname(directory);
  const isRepoRoot = existsSync(path.join(directory, ".git")) || parent === directory;
  return isRepoRoot ? [directory] : [directory, ...ancestorsUpToRepoRoot(parent)];
};

const detectPackageManager = (backDir, userConfig, packageJson) => {
  const lockfileFor = (manager) => {
    const found = ancestorsUpToRepoRoot(backDir)
      .map((directory) => path.join(directory, PACKAGE_MANAGERS[manager]))
      .find((candidate) => existsSync(candidate));
    return found ? path.relative(backDir, found) : PACKAGE_MANAGERS[manager];
  };
  if (userConfig.packageManager) {
    return { value: userConfig.packageManager, lockfile: lockfileFor(userConfig.packageManager), source: ".mutation.json" };
  }
  // The closest lockfile wins: a service with its own yarn.lock inside a pnpm repo is yarn.
  const detected = ancestorsUpToRepoRoot(backDir)
    .flatMap((directory) =>
      Object.entries(PACKAGE_MANAGERS).map(([manager, lockfileName]) => ({ manager, lockfile: path.join(directory, lockfileName) })),
    )
    .find(({ lockfile }) => existsSync(lockfile));
  if (detected) {
    return { value: detected.manager, lockfile: path.relative(backDir, detected.lockfile), source: `detected from ${path.relative(backDir, detected.lockfile)}` };
  }
  const declared = /^(pnpm|yarn|npm)@/.exec(packageJson.packageManager ?? "")?.[1];
  if (declared) return { value: declared, lockfile: lockfileFor(declared), source: 'detected from the "packageManager" field of package.json' };
  return { value: "npm", lockfile: lockfileFor("npm"), source: "default: no lockfile found" };
};

const detectScript = (configured, key, defaults, scripts) => {
  if (configured) {
    if (!Object.hasOwn(scripts, configured)) throw new ConfigError(`.mutation.json: ${key} "${configured}" is not a script in package.json`);
    return { name: configured, source: ".mutation.json" };
  }
  const name = defaults.find((candidate) => Object.hasOwn(scripts, candidate));
  return name ? { name, source: "detected" } : { name: null, source: `none of ${defaults.join(", ")} in package.json` };
};

const readScript = (scriptName, scripts) => {
  const invocation = scriptName ? findJestInvocation(scripts[scriptName], scripts) : null;
  return { script: { name: scriptName, found: invocation !== null }, env: invocation?.env ?? {}, flags: readJestFlags(invocation?.args ?? []) };
};

// The integration stage: which tests count as integration, their setup and environment, and how
// each Stryker runner gets a database of its own (a shard). Without a database, one runner.
const resolveIntegration = (userIntegration, scripts) => {
  const configured = userIntegration ?? {};
  const testScript = detectScript(configured.testScript, "integration.testScript", DEFAULT_INTEGRATION_TEST_SCRIPTS, scripts);
  const { script, env, flags } = readScript(testScript.name, scripts);
  const testMatch = fromUserOrScript(configured.testMatch, flags.testMatch, script, []);
  const setupFiles = fromUserOrScript(configured.setupFilesAfterEnv, flags.setupFilesAfterEnv, script, []);
  const testEnv = fromUserOrScript(configured.env, env, script, {});
  const database = configured.database ?? null;
  const concurrency = database
    ? { value: configured.concurrency ?? DEFAULT_INTEGRATION_CONCURRENCY, source: configured.concurrency ? ".mutation.json" : "default" }
    : { value: 1, source: "no integration.database: one runner, so tests never share a database" };
  return {
    value: {
      testScript: testScript.name,
      testMatch: testMatch.value,
      setupFilesAfterEnv: setupFiles.value,
      env: testEnv.value,
      concurrency: concurrency.value,
      database,
    },
    source: {
      testScript: testScript.source,
      testMatch: testMatch.source,
      setupFilesAfterEnv: setupFiles.source,
      env: testEnv.source,
      concurrency: concurrency.source,
      database: database ? ".mutation.json" : "none",
    },
  };
};

const detectJestConfig = (backDir, flags, packageJson) => {
  if (flags.config) return { value: flags.config, source: "--config of the unit test script" };
  const file = JEST_CONFIG_FILES.find((name) => existsSync(path.join(backDir, name)));
  if (file) return { value: file, source: "detected" };
  if (packageJson.jest) return { value: "package.json", source: 'detected: "jest" key in package.json' };
  return { value: null, source: "none found: jest defaults" };
};

const fromUserOrScript = (userValue, scriptValue, script, fallback) => {
  if (userValue !== undefined) return { value: userValue, source: ".mutation.json" };
  if (script.found) return { value: scriptValue, source: `"${script.name}" script` };
  return { value: fallback, source: script.name ? `default: "${script.name}" does not run jest` : "default" };
};

const numberSetting = (env, envName, userValue, fallback) => {
  const fromEnv = env[envName];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!/^[1-9]\d*$/.test(fromEnv)) throw new ConfigError(`${envName} must be a positive integer, got "${fromEnv}"`);
    return { value: Number(fromEnv), source: `env ${envName}` };
  }
  if (userValue !== undefined) return { value: userValue, source: ".mutation.json" };
  return { value: fallback, source: "default" };
};

export const resolveConfig = (backDirArg, env = process.env) => {
  const backDir = path.resolve(backDirArg);
  const packageJsonPath = path.join(backDir, "package.json");
  if (!existsSync(packageJsonPath)) throw new ConfigError(`${backDir} has no package.json`);
  const packageJson = readJson(packageJsonPath, "package.json");
  const scripts = packageJson.scripts ?? {};
  const userConfig = readUserConfig(backDir);

  const unitScript = detectScript(userConfig.unitTestScript, "unitTestScript", DEFAULT_UNIT_TEST_SCRIPTS, scripts);
  const { script, env: scriptEnv, flags } = readScript(unitScript.name, scripts);

  const packageManager = detectPackageManager(backDir, userConfig, packageJson);
  const jestConfig = detectJestConfig(backDir, flags, packageJson);
  const unitIgnores = fromUserOrScript(userConfig.unitTestIgnorePatterns, flags.testPathIgnorePatterns, script, DEFAULT_UNIT_TEST_IGNORE_PATTERNS);
  const setupFiles = fromUserOrScript(userConfig.setupFilesAfterEnv, flags.setupFilesAfterEnv, script, []);
  const testEnv = fromUserOrScript(userConfig.env, scriptEnv, script, {});
  const integration = resolveIntegration(userConfig.integration, scripts);
  const concurrency = numberSetting(env, "MUTATE_CONCURRENCY", userConfig.concurrency, DEFAULT_CONCURRENCY);
  const reuse = numberSetting(env, "MUTATE_REUSE", userConfig.maxTestRunnerReuse, DEFAULT_REUSE);

  const extraIgnoreCalls = userConfig.ignoreCalls ?? [];
  const ignoreCalls = userConfig.replaceDefaultIgnoreCalls ? extraIgnoreCalls : [...DEFAULT_IGNORE_CALLS, ...extraIgnoreCalls];
  const ignoreCallsSource = userConfig.replaceDefaultIgnoreCalls
    ? ".mutation.json (replaces the defaults)"
    : extraIgnoreCalls.length > 0
      ? ".mutation.json (added to the defaults)"
      : "default";

  const effective = {
    packageManager: packageManager.value,
    lockfile: packageManager.lockfile,
    unitTestScript: unitScript.name,
    jestConfig: jestConfig.value,
    unitTestIgnorePatterns: unitIgnores.value,
    setupFilesAfterEnv: setupFiles.value,
    env: testEnv.value,
    ignoreCalls,
    excludedMutations: userConfig.excludedMutations ?? [],
    concurrency: concurrency.value,
    maxTestRunnerReuse: reuse.value,
    integration: integration.value,
  };
  const sources = {
    packageManager: packageManager.source,
    unitTestScript: unitScript.source,
    jestConfig: jestConfig.source,
    unitTestIgnorePatterns: unitIgnores.source,
    setupFilesAfterEnv: setupFiles.source,
    env: testEnv.source,
    ignoreCalls: ignoreCallsSource,
    excludedMutations: userConfig.excludedMutations ? ".mutation.json" : "default",
    concurrency: concurrency.source,
    maxTestRunnerReuse: reuse.source,
    integration: integration.source,
  };
  const report = Object.keys(sources)
    .filter((key) => key !== "integration")
    .map((key) => `${key}: ${JSON.stringify(effective[key])} (${sources[key]})`);
  const integrationReport = Object.keys(integration.source).map(
    (key) => `integration.${key}: ${JSON.stringify(key === "database" && integration.value.database ? { env: integration.value.database.env, template: integration.value.database.template } : integration.value[key])} (${integration.source[key]})`,
  );
  return { effective, sources, report, integrationReport };
};
