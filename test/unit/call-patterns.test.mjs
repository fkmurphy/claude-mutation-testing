import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallMatcher, patternToRegExp, renderCallee } from "../../skills/mutation-testing/assets/call-patterns.mjs";
import { DEFAULT_IGNORE_CALLS } from "../../skills/mutation-testing/scripts/lib/config.mjs";

const id = (name) => ({ type: "Identifier", name });
const self = { type: "ThisExpression" };
const member = (object, name, optional = false) => ({
  type: optional ? "OptionalMemberExpression" : "MemberExpression",
  object,
  property: id(name),
  computed: false,
});
const call = (callee, optional = false) => ({ type: optional ? "OptionalCallExpression" : "CallExpression", callee, arguments: [] });
const chain = (root, ...names) => names.reduce((object, name) => member(object, name), root);

describe("patternToRegExp", () => {
  it("lets * stand for one name and never cross a dot", () => {
    assert.ok(patternToRegExp("*logger.info").test("baseLogger.info"));
    assert.ok(!patternToRegExp("*logger.info").test("this.logger.info"));
  });

  it("reads {a,b} as one of the names and escapes the rest", () => {
    const expression = patternToRegExp("getLogger().{info,warn}");
    assert.ok(expression.test("getLogger().warn"));
    assert.ok(!expression.test("getLogger().error"));
    assert.ok(!expression.test("getLoggerX.info"));
  });
});

describe("renderCallee", () => {
  it("renders names, this, calls in the chain, and null for computed members", () => {
    assert.equal(renderCallee(member(call(member(id("log"), "child")), "info")), "log.child().info");
    assert.equal(renderCallee(chain(self, "logger", "warn")), "this.logger.warn");
    assert.equal(renderCallee({ ...member(id("logger"), "info"), computed: true }), null);
  });
});

describe("the default ignore list", () => {
  const isIgnored = createCallMatcher(DEFAULT_IGNORE_CALLS);

  const ignored = {
    "logger.info()": call(chain(id("logger"), "info")),
    "this.logger.warn()": call(chain(self, "logger", "warn")),
    "this.baseLogger.error()": call(chain(self, "baseLogger", "error")),
    "getLogger().debug()": call(member(call(id("getLogger")), "debug")),
    "requestLogger.child({}).info()": call(member(call(chain(id("requestLogger"), "child")), "info")),
    "logger?.info()": call(member(id("logger"), "info", true), true),
    "console.log()": call(chain(id("console"), "log")),
  };
  const mutated = {
    "auditLogger.record()": call(chain(id("auditLogger"), "record")),
    "order.info()": call(chain(id("order"), "info")),
    "this.deps.logger.info()": call(chain(self, "deps", "logger", "info")),
    "info()": call(id("info")),
  };

  Object.entries(ignored).forEach(([label, node]) => it(`ignores ${label}`, () => assert.ok(isIgnored(node))));
  Object.entries(mutated).forEach(([label, node]) => it(`mutates ${label}`, () => assert.ok(!isIgnored(node))));
});
