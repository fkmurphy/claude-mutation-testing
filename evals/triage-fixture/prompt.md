---
max_turns: 6
allowed_tools: [Skill, Read, Glob, Grep]
tags: [triage]
---

I ran `mutate.sh` from the mutation plugin on `src/discount.js` and got the `summary.json` below. Probing is not possible right now: triage the survivors by reading, and give me the result in the plugin's output format. Do not write any file.

`src/discount.js`:

```js
const logger = { info: () => {} };

function applyDiscount(price, customer) {
  logger.info("discount.applied", { price, vip: customer.isVip });
  if (price <= 0) return 0;
  const rate = customer.isVip ? 0.2 : 0;
  return Math.round(price * (1 - rate));
}

function allActive(customers) {
  if (customers.length === 0) return true;
  return customers.every((customer) => customer.active);
}

module.exports = { applyDiscount, allActive };
```

`test/unit/discount.test.js`:

```js
const { applyDiscount, allActive } = require("../../src/discount");

describe("applyDiscount", () => {
  it("takes 20% off for a VIP", () => {
    expect(applyDiscount(100, { isVip: true })).toBe(80);
  });

  it("charges the full price otherwise", () => {
    expect(applyDiscount(100, { isVip: false })).toBe(100);
  });

  it("never returns a negative price", () => {
    expect(applyDiscount(-5, { isVip: false })).toBe(0);
  });
});

describe("allActive", () => {
  it("is true for an active customer", () => {
    expect(allActive([{ active: true }])).toBe(true);
  });

  it("is false for an inactive customer", () => {
    expect(allActive([{ active: false }])).toBe(false);
  });

  it("is true for no customers", () => {
    expect(allActive([])).toBe(true);
  });
});
```

`summary.json`:

```json
{
  "summary": {
    "files": 1,
    "mutants": 19,
    "killed": 11,
    "timeout": 0,
    "survived": 3,
    "noCoverage": 0,
    "ignored": 5,
    "compileError": 0,
    "runtimeError": 0,
    "scoreOverValid": 78.57,
    "scoreOverCovered": 78.57,
    "suspiciousKills": 0,
    "timeoutsRechecked": 0,
    "timeoutsRevived": 0,
    "timeoutsInconclusive": 0
  },
  "warnings": [],
  "survivors": [
    {
      "id": "7",
      "file": "src/discount.js",
      "line": 5,
      "mutator": "EqualityOperator",
      "original": "price <= 0",
      "replacement": "price < 0",
      "lineText": "if (price <= 0) return 0;",
      "coveredBy": [
        "test/unit/discount.test.js › applyDiscount takes 20% off for a VIP",
        "test/unit/discount.test.js › applyDiscount charges the full price otherwise",
        "test/unit/discount.test.js › applyDiscount never returns a negative price"
      ],
      "coveredByCount": 3
    },
    {
      "id": "13",
      "file": "src/discount.js",
      "line": 11,
      "mutator": "ConditionalExpression",
      "original": "customers.length === 0",
      "replacement": "false",
      "lineText": "if (customers.length === 0) return true;",
      "coveredBy": [
        "test/unit/discount.test.js › allActive is true for an active customer",
        "test/unit/discount.test.js › allActive is false for an inactive customer",
        "test/unit/discount.test.js › allActive is true for no customers"
      ],
      "coveredByCount": 3
    },
    {
      "id": "16",
      "file": "src/discount.js",
      "line": 12,
      "mutator": "MethodExpression",
      "original": "customers.every((customer) => customer.active)",
      "replacement": "customers.some(customer => customer.active)",
      "lineText": "return customers.every((customer) => customer.active);",
      "coveredBy": [
        "test/unit/discount.test.js › allActive is true for an active customer",
        "test/unit/discount.test.js › allActive is false for an inactive customer"
      ],
      "coveredByCount": 2
    }
  ],
  "noCoverage": [],
  "suspiciousKills": []
}
```
