// Finds the jest invocation behind a package.json script, following `pnpm run x`, `npm run x`
// and `yarn x` references, and reads from it what the unit suite needs: the environment
// assignments in front of jest and the flags that shape which tests run.

const MAX_DEPTH = 8;
const OPERATORS = new Set(["&&", "||", ";", "|"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const ARRAY_FLAGS = new Set(["testPathIgnorePatterns", "setupFilesAfterEnv"]);
const VALUE_FLAGS = new Set(["config"]);
const FLAG_ALIASES = { c: "config" };

export const tokenize = (command) => {
  const tokens = [];
  let current = null;
  let quote = null;
  [...command].forEach((char) => {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      return;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current ??= "";
      return;
    }
    if (/\s/.test(char)) {
      if (current !== null) tokens.push(current);
      current = null;
      return;
    }
    if (char === ";") {
      if (current !== null) tokens.push(current);
      tokens.push(";");
      current = null;
      return;
    }
    current = (current ?? "") + char;
  });
  if (current !== null) tokens.push(current);
  return tokens;
};

const splitSegments = (tokens) =>
  tokens.reduce(
    (segments, token) => (OPERATORS.has(token) ? [...segments, []] : [...segments.slice(0, -1), [...segments.at(-1), token]]),
    [[]],
  );

const takeEnvironment = (tokens) => {
  const skipped = tokens[0] === "cross-env" ? tokens.slice(1) : tokens;
  const firstCommand = skipped.findIndex((token) => !ENV_ASSIGNMENT.test(token));
  const assignments = firstCommand === -1 ? skipped : skipped.slice(0, firstCommand);
  return {
    env: Object.fromEntries(assignments.map((token) => ENV_ASSIGNMENT.exec(token).slice(1, 3))),
    command: firstCommand === -1 ? [] : skipped.slice(firstCommand),
  };
};

const isJestBinary = (token) => token === "jest" || /(^|\/)jest(\.js)?$/.test(token) || /(^|\/)jest\/bin\/jest(\.js)?$/.test(token);

// `pnpm run x -- --flag`, `npm run x -- --flag`, `yarn x --flag`, `pnpm exec jest`, `npx jest`.
const classify = (command, scripts) => {
  if (command.length === 0) return { kind: "other" };
  if (isJestBinary(command[0])) return { kind: "jest", args: command.slice(1) };
  if (command[0] === "npx" && isJestBinary(command[1] ?? "")) return { kind: "jest", args: command.slice(2) };
  if (!PACKAGE_MANAGERS.has(command[0])) return { kind: "other" };
  const rest = command.slice(1).filter((token) => !token.startsWith("--silent") && token !== "-s");
  const afterRun = rest[0] === "run" || rest[0] === "run-script" || rest[0] === "exec" ? rest.slice(1) : rest;
  const [name, ...extra] = afterRun;
  const args = extra[0] === "--" ? extra.slice(1) : extra;
  if (name && Object.hasOwn(scripts, name)) return { kind: "script", name, args };
  if (name && isJestBinary(name)) return { kind: "jest", args };
  return { kind: "other" };
};

export const findJestInvocation = (command, scripts, depth = 0) => {
  if (depth > MAX_DEPTH) return null;
  return splitSegments(tokenize(command)).reduce((found, segment) => {
    if (found) return found;
    const { env, command: words } = takeEnvironment(segment);
    const target = classify(words, scripts);
    if (target.kind === "jest") return { env, args: target.args };
    if (target.kind !== "script") return null;
    const inner = findJestInvocation(scripts[target.name], scripts, depth + 1);
    return inner ? { env: { ...inner.env, ...env }, args: [...inner.args, ...target.args] } : null;
  }, null);
};

const camelCase = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

// Mirrors jest's own CLI: an array flag takes every following value until the next flag.
export const readJestFlags = (args) => {
  const flags = { testPathIgnorePatterns: [], setupFilesAfterEnv: [], config: null };
  const assign = (name, values) => {
    if (ARRAY_FLAGS.has(name)) flags[name].push(...values);
    if (VALUE_FLAGS.has(name) && values.length > 0) flags[name] = values[0];
  };
  args.forEach((token, index) => {
    const match = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/s.exec(token);
    if (!match) return;
    const name = FLAG_ALIASES[match[1]] ?? camelCase(match[1]);
    if (match[2] !== undefined) return assign(name, [match[2]]);
    const following = args.slice(index + 1);
    const nextFlag = following.findIndex((value) => value.startsWith("-"));
    const values = nextFlag === -1 ? following : following.slice(0, nextFlag);
    assign(name, VALUE_FLAGS.has(name) ? values.slice(0, 1) : values);
  });
  return {
    ...flags,
    testPathIgnorePatterns: [...new Set(flags.testPathIgnorePatterns)],
    setupFilesAfterEnv: [...new Set(flags.setupFilesAfterEnv)],
  };
};
