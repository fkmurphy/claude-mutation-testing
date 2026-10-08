import { readFileSync } from "node:fs";
import { declareValuePlugin, PluginKind } from "@stryker-mutator/api/plugin";

const REASON = "Instrumentation is not business logic: what gets logged is not tested.";
const CALL_TYPES = new Set(["CallExpression", "OptionalCallExpression"]);
const MEMBER_TYPES = new Set(["MemberExpression", "OptionalMemberExpression"]);

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const literalToRegExp = (text) => text.split("*").map(escapeRegExp).join("[^.()]*");

// "this.*logger.{info,warn}" matches `this.logger.info(...)` and `this.baseLogger.warn(...)`. `*`
// stands for one name: it never crosses a dot or a call. `{a,b}` is one of the listed names.
const patternToRegExp = (pattern) => {
  const source = pattern
    .split(/(\{[^{}]*\})/)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? `(?:${part.slice(1, -1).split(",").map(literalToRegExp).join("|")})`
        : literalToRegExp(part),
    )
    .join("");
  return new RegExp(`^${source}$`, "i");
};

const patterns = JSON.parse(readFileSync(new URL("./ignore-calls.json", import.meta.url), "utf8")).map(patternToRegExp);

const render = (node) => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (MEMBER_TYPES.has(node.type) && !node.computed && node.property.type === "Identifier") {
    const object = render(node.object);
    return object && `${object}.${node.property.name}`;
  }
  if (CALL_TYPES.has(node.type)) {
    const callee = render(node.callee);
    return callee && `${callee}()`;
  }
  return null;
};

const isIgnoredCall = (node) => {
  if (!node || !CALL_TYPES.has(node.type) || !MEMBER_TYPES.has(node.callee.type)) return false;
  const callee = render(node.callee);
  return callee !== null && patterns.some((pattern) => pattern.test(callee));
};

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, "log-calls", {
    shouldIgnore(path) {
      const { node } = path;
      // Stryker 10 also mutates the whole statement (`logger.info(...);` → `;`), so the node
      // to ignore can be the call or the statement wrapping it.
      if (isIgnoredCall(node) || (node.type === "ExpressionStatement" && isIgnoredCall(node.expression))) {
        return REASON;
      }
    },
  }),
];
