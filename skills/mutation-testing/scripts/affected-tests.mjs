// Finds the tests that reach the given lines, without running anything: walks references upward
// with the project's own TypeScript language service, follows Express routes (hand-written
// routers and generated ones such as tsoa's) to the tests that call their URL, and reports the
// places where the static walk cannot continue.
//
// Usage: node affected-tests.mjs <back-dir> <file>[:<from>-<to>] [...]
// Output: JSON on stdout.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);
const MAX_NODES = Number(process.env.AFFECTED_MAX_NODES ?? 400);
const HUB_REFERENCES = Number(process.env.AFFECTED_HUB_REFERENCES ?? 60);
const TEST_FILE = /(\.(test|spec)\.[jt]sx?$)|(\/src\/test\/)/;

const [backDirArg, ...specs] = process.argv.slice(2);
if (!backDirArg || specs.length === 0) {
  console.error("usage: node affected-tests.mjs <back-dir> <file>[:<from>-<to>] [...]");
  process.exit(2);
}
const started = Date.now();
const backDir = path.resolve(backDirArg);
const ts = createRequire(path.join(backDir, "package.json"))("typescript");

const configPath = ts.findConfigFile(backDir, ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error(`no tsconfig.json found from ${backDir}`);
  process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath));
const snapshots = new Map();
const service = ts.createLanguageService(
  {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (file) => {
      if (!snapshots.has(file) && existsSync(file)) snapshots.set(file, ts.ScriptSnapshot.fromString(readFileSync(file, "utf8")));
      return snapshots.get(file);
    },
    getCurrentDirectory: () => backDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  },
  ts.createDocumentRegistry(),
);
const program = service.getProgram();
const relative = (file) => path.relative(backDir, file);
const lineOf = (sourceFile, position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
const isTestFile = (file) => TEST_FILE.test(file);

const deepestNodeAt = (sourceFile, position) => {
  const descend = (node) => ts.forEachChild(node, (child) => (child.getStart(sourceFile) <= position && position < child.getEnd() ? descend(child) ?? child : undefined));
  return descend(sourceFile) ?? sourceFile;
};

// A function-like declaration and the identifier that other code uses to reach it.
const nameOfFunctionLike = (node) => {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return node.name;
  if (ts.isConstructorDeclaration(node)) return node.parent.name;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
    const { parent } = node;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name;
  }
  return undefined;
};

const enclosingFunctionLike = (node) => {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (nameOfFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
};

const isModuleExports = (node) =>
  (ts.isIdentifier(node) && node.text === "exports") ||
  (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "module" && node.name.text === "exports");

// A CommonJS export of a reference: `module.exports = { fn }`, `{ name: fn }`, `exports.name = fn`.
// Returns the exported name, whose references are the require() sites; ES exports need no hop
// because the language service already follows import aliases.
const commonJsExportName = (node) => {
  const { parent } = node;
  if (!parent) return undefined;
  const assignedObject = (objectLiteral) =>
    ts.isObjectLiteralExpression(objectLiteral) &&
    ts.isBinaryExpression(objectLiteral.parent) &&
    objectLiteral.parent.right === objectLiteral &&
    isModuleExports(objectLiteral.parent.left);
  if (ts.isShorthandPropertyAssignment(parent) && assignedObject(parent.parent)) return parent.name;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node && assignedObject(parent.parent)) return parent.name;
  if (ts.isBinaryExpression(parent) && parent.right === node && ts.isPropertyAccessExpression(parent.left) && isModuleExports(parent.left.expression)) {
    return parent.left.name;
  }
  return undefined;
};

const resolvesTo = (specifier, containingFile, target) =>
  ts.resolveModuleName(specifier, containingFile, parsed.options, ts.sys).resolvedModule?.resolvedFileName === target;

// The local names a CommonJS export is bound to: `const { name } = require("./x")` and
// `const { name: alias } = require("./x")`. `const x = require("./x")` followed by `x.name` is not
// followed: it surfaces as a missing test, never as a wrong one.
const requireSites = (exportingFile, exportName) =>
  program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.fileName.includes("node_modules"))
    .flatMap((sourceFile) => {
      const found = [];
      const visit = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "require" &&
          node.initializer.arguments[0] &&
          ts.isStringLiteral(node.initializer.arguments[0]) &&
          ts.isObjectBindingPattern(node.name) &&
          resolvesTo(node.initializer.arguments[0].text, sourceFile.fileName, exportingFile)
        ) {
          node.name.elements
            .filter((element) => (element.propertyName ?? element.name).getText(sourceFile) === exportName && ts.isIdentifier(element.name))
            .forEach((element) => found.push({ sourceFile, nameNode: element.name }));
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return found;
    });

const describe = (sourceFile, declaration) => {
  const name = nameOfFunctionLike(declaration);
  const owner = declaration.parent && ts.isClassLike(declaration.parent) && declaration.parent.name ? `${declaration.parent.name.text}.` : "";
  return `${relative(sourceFile.fileName)}:${lineOf(sourceFile, declaration.getStart(sourceFile))} ${owner}${name?.getText(sourceFile) ?? "?"}`;
};

const pathLiteral = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.startsWith("/") ? node.text : undefined);

// `<router>.<method>("/path", ...handlers)` around a reference, if any.
const routeAround = (sourceFile, node) => {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text.toLowerCase();
      const routePath = pathLiteral(current.arguments[0]);
      if (HTTP_METHODS.has(method) && routePath) return { method, path: routePath, router: current.expression.expression, sourceFile };
    }
    current = current.parent;
  }
  return undefined;
};

// `<router>.use(middleware)` or `<router>.use("/prefix", middleware)` around a reference: the
// middleware runs for every route of that router.
const middlewareMountAround = (node) => {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(node)) return undefined;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "use" || !ts.isIdentifier(call.expression.expression)) return undefined;
  return { router: call.expression.expression, prefix: pathLiteral(call.arguments[0]) ?? "" };
};

// The routes declared on a router in its own file: `<router>.<method>("/path", ...)`.
const routesOf = (sourceFile, router) => {
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === router.text &&
      HTTP_METHODS.has(node.expression.name.text.toLowerCase()) &&
      pathLiteral(node.arguments[0])
    ) {
      found.push({ method: node.expression.name.text.toLowerCase(), path: pathLiteral(node.arguments[0]) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

// The decorator a reference sits in, e.g. tsoa's `@Middlewares([guard])`: the decorated method,
// or every method of the decorated class, is where the walk goes on.
const decoratedTargets = (node) => {
  let current = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isDecorator(current)) current = current.parent;
  if (!current || !ts.isDecorator(current)) return undefined;
  const decorated = current.parent;
  if (ts.isMethodDeclaration(decorated)) return [decorated];
  if (ts.isClassDeclaration(decorated)) return decorated.members.filter((member) => ts.isMethodDeclaration(member) && member.name);
  return undefined;
};

// Prefixes a router is mounted under, through `<parent>.use("/prefix", ..., router)`.
const mountPrefixes = (sourceFile, routerExpression, depth = 0) => {
  if (depth > 5 || !ts.isIdentifier(routerExpression)) return [""];
  const references = service.findReferences(sourceFile.fileName, routerExpression.getStart(sourceFile)) ?? [];
  const prefixes = references.flatMap(({ references: entries }) =>
    entries.flatMap((entry) => {
      const file = program.getSourceFile(entry.fileName);
      const reference = deepestNodeAt(file, entry.textSpan.start);
      let current = reference.parent;
      while (current && !ts.isSourceFile(current)) {
        // Only `<parent>.use("/prefix", router)` mounts it: in `router.use(...)` the router is the
        // one mounting something else.
        const mountsReference =
          ts.isCallExpression(current) && current.arguments.some((argument) => argument.pos <= reference.pos && reference.end <= argument.end);
        if (mountsReference && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "use") {
          const prefix = pathLiteral(current.arguments[0]);
          if (prefix === undefined) return [];
          return mountPrefixes(file, current.expression.expression, depth + 1).map((outer) => `${outer}${prefix}`);
        }
        current = current.parent;
      }
      return [];
    }),
  );
  return prefixes.length > 0 ? [...new Set(prefixes)] : [""];
};

const segments = (routePath) =>
  routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith(":") || segment.startsWith("{") || segment === "*" ? "*" : segment));
const sameRoute = (left, right) => left.length === right.length && left.every((segment, index) => segment === right[index] || segment === "*" || right[index] === "*");

// Every `<client>.<method>("/url")` in the test files, with template spans as wildcards.
const testCalls = program
  .getSourceFiles()
  .filter((sourceFile) => isTestFile(sourceFile.fileName) && !sourceFile.fileName.includes("node_modules"))
  .flatMap((sourceFile) => {
    const calls = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && HTTP_METHODS.has(node.expression.name.text.toLowerCase())) {
        const [first] = node.arguments;
        const url = pathLiteral(first) ?? (first && ts.isTemplateExpression(first) ? [first.head.text, ...first.templateSpans.map((span) => `*${span.literal.text}`)].join("") : undefined);
        if (url?.startsWith("/")) calls.push({ file: sourceFile.fileName, method: node.expression.name.text.toLowerCase(), segments: segments(url.split("?")[0]) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls;
  });

// Starting points: the innermost named function-like around each changed line.
const starts = new Map();
const moduleLevel = [];
specs.forEach((spec) => {
  const [file, range] = spec.split(":");
  const sourceFile = program.getSourceFile(path.resolve(backDir, file));
  if (!sourceFile) throw new Error(`${file} is not part of the TypeScript project`);
  const [from, to] = range ? range.split("-").map(Number) : [1, sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1];
  Array.from({ length: to - from + 1 }, (_, index) => from + index).forEach((line) => {
    const lineStarts = sourceFile.getLineStarts();
    if (line > lineStarts.length) return;
    const position = lineStarts[line - 1];
    const text = sourceFile.text.slice(position, lineStarts[line] ?? sourceFile.getEnd()).trim();
    if (!text || text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
    const node = deepestNodeAt(sourceFile, position + (sourceFile.text.slice(position).length - sourceFile.text.slice(position).trimStart().length));
    const declaration = nameOfFunctionLike(node) ? node : enclosingFunctionLike(node);
    if (declaration) starts.set(`${sourceFile.fileName}:${declaration.getStart(sourceFile)}`, { sourceFile, declaration });
    else moduleLevel.push(`${relative(sourceFile.fileName)}:${line}`);
  });
});

const warnings = [];
if (!program.getSourceFiles().some((sourceFile) => isTestFile(sourceFile.fileName) && !sourceFile.fileName.includes("node_modules"))) {
  warnings.push("the TypeScript project has no test files (tsconfig probably excludes them): no test can be found");
}

const tests = new Map();
const routes = [];
const roots = [];
const hubs = [];
const visited = new Set();
const followRoute = (sourceFile, router, method, routePath, chain) =>
  mountPrefixes(sourceFile, router).forEach((prefix) => {
    const fullPath = `${prefix}${routePath}`.replace(/\/+/g, "/");
    const routeSegments = segments(fullPath);
    const callers = testCalls.filter((call) => call.method === method && sameRoute(call.segments, routeSegments));
    routes.push({ method: method.toUpperCase(), path: fullPath, tests: [...new Set(callers.map((call) => relative(call.file)))].length, chain });
    callers.forEach((call) => addTest(call.file, "http", [...chain, `${method.toUpperCase()} ${fullPath}`]));
  });

const queue = [...starts.values()].map(({ sourceFile, declaration }) => ({
  sourceFile,
  nameNode: nameOfFunctionLike(declaration),
  chain: [describe(sourceFile, declaration)],
}));

const addTest = (file, kind, chain) => {
  const key = relative(file);
  if (!tests.has(key)) tests.set(key, { file: key, kind, via: chain });
};

while (queue.length > 0 && visited.size < MAX_NODES) {
  const { sourceFile, nameNode, chain } = queue.shift();
  const key = `${sourceFile.fileName}:${nameNode.getStart(sourceFile)}`;
  if (visited.has(key)) continue;
  visited.add(key);

  const entries = (service.findReferences(sourceFile.fileName, nameNode.getStart(sourceFile)) ?? [])
    .flatMap(({ references }) => references)
    .filter((entry) => !entry.isDefinition);
  if (entries.length > HUB_REFERENCES) {
    hubs.push({ symbol: chain.at(-1), references: entries.length, chain });
    continue;
  }
  entries.forEach((entry) => {
    const file = program.getSourceFile(entry.fileName);
    if (!file || entry.fileName.includes("node_modules")) return;
    const node = deepestNodeAt(file, entry.textSpan.start);
    if (node.parent && (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isExportSpecifier(node.parent))) return;
    if (isTestFile(entry.fileName)) return addTest(entry.fileName, "direct", chain);

    const route = routeAround(file, node);
    if (route) return followRoute(route.sourceFile, route.router, route.method, route.path, chain);

    const mount = middlewareMountAround(node);
    if (mount) {
      const mounted = routesOf(file, mount.router);
      if (mounted.length > 0) {
        const step = `${relative(entry.fileName)}:${lineOf(file, entry.textSpan.start)} ${mount.router.text}.use(${node.getText(file)})`;
        return mounted.forEach(({ method, path: routePath }) => followRoute(file, mount.router, method, `${mount.prefix}${routePath}`, [...chain, step]));
      }
    }

    const targets = decoratedTargets(node);
    if (targets) {
      return targets.forEach((method) => queue.push({ sourceFile: file, nameNode: method.name, chain: [...chain, describe(file, method)] }));
    }

    const exported = commonJsExportName(node);
    if (exported) {
      const hop = `${relative(entry.fileName)}:${lineOf(file, exported.getStart(file))} module.exports.${exported.text}`;
      return requireSites(entry.fileName, exported.text).forEach(({ sourceFile: requirer, nameNode: binding }) => {
        const step = `${relative(requirer.fileName)}:${lineOf(requirer, binding.getStart(requirer))} require → ${binding.text}`;
        if (isTestFile(requirer.fileName)) return addTest(requirer.fileName, "direct", [...chain, hop, step]);
        queue.push({ sourceFile: requirer, nameNode: binding, chain: [...chain, hop, step] });
      });
    }
    const caller = enclosingFunctionLike(node);
    if (caller) return queue.push({ sourceFile: file, nameNode: nameOfFunctionLike(caller), chain: [...chain, describe(file, caller)] });
    roots.push({ at: `${relative(entry.fileName)}:${lineOf(file, entry.textSpan.start)}`, code: node.parent.getText(file).slice(0, 120), chain });
  });
}

console.log(
  JSON.stringify(
    {
      warnings,
      starts: [...starts.values()].map(({ sourceFile, declaration }) => describe(sourceFile, declaration)),
      moduleLevel,
      tests: [...tests.values()],
      routes,
      roots,
      hubs,
      stats: { nodes: visited.size, truncated: queue.length > 0, ms: Date.now() - started },
    },
    null,
    2,
  ),
);
