// Matches call expressions against patterns such as `this.*logger.{info,warn}`. `*` stands for
// one name: it never crosses a dot or a call. `{a,b}` is one of the listed names.
const CALL_TYPES = new Set(["CallExpression", "OptionalCallExpression"]);
const MEMBER_TYPES = new Set(["MemberExpression", "OptionalMemberExpression"]);

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const literalToRegExp = (text) => text.split("*").map(escapeRegExp).join("[^.()]*");

export const patternToRegExp = (pattern) => {
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

// `this.logger.child({ a }).info` renders as "this.logger.child().info"; anything that is not a
// chain of names and calls (a computed member, a literal) renders as null and never matches.
export const renderCallee = (node) => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (MEMBER_TYPES.has(node.type) && !node.computed && node.property.type === "Identifier") {
    const object = renderCallee(node.object);
    return object && `${object}.${node.property.name}`;
  }
  if (CALL_TYPES.has(node.type)) {
    const callee = renderCallee(node.callee);
    return callee && `${callee}()`;
  }
  return null;
};

export const createCallMatcher = (patterns) => {
  const expressions = patterns.map(patternToRegExp);
  return (node) => {
    if (!node || !CALL_TYPES.has(node.type) || !MEMBER_TYPES.has(node.callee.type)) return false;
    const callee = renderCallee(node.callee);
    return callee !== null && expressions.some((expression) => expression.test(callee));
  };
};
