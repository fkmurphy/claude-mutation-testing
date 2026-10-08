import { readFileSync } from "node:fs";
import { declareValuePlugin, PluginKind } from "@stryker-mutator/api/plugin";
import { createCallMatcher } from "./call-patterns.mjs";

const REASON = "Instrumentation is not business logic: what gets logged is not tested.";

const isIgnoredCall = createCallMatcher(JSON.parse(readFileSync(new URL("./ignore-calls.json", import.meta.url), "utf8")));

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
