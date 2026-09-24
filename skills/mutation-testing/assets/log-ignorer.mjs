import { declareValuePlugin, PluginKind } from "@stryker-mutator/api/plugin";

const LOG_METHODS = new Set(["info", "warn", "error", "debug", "trace", "child"]);

const isLoggerObject = (node) =>
  (node.type === "Identifier" && /logger$/i.test(node.name)) ||
  (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "getLogger");

const isLogCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.property.type === "Identifier" &&
  LOG_METHODS.has(node.callee.property.name) &&
  isLoggerObject(node.callee.object);

const REASON = "Instrumentation is not business logic: what gets logged is not tested.";

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, "log-calls", {
    shouldIgnore(path) {
      const { node } = path;
      // Stryker 10 also mutates the whole statement (`logger.info(...);` → `;`), so the node
      // to ignore can be the call or the statement wrapping it.
      if (isLogCall(node) || (node.type === "ExpressionStatement" && isLogCall(node.expression))) {
        return REASON;
      }
    },
  }),
];
