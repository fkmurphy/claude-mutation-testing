---
type: llm
weight: 3
---

There is exactly one `gap`, and it is `src/discount.js:12` (`every` → `some`). Passes if all hold:

- It says the tests only use one-element arrays, where `every` and `some` agree.
- It gives a concrete distinguishing input with at least one active and one inactive customer (for example `[{ active: true }, { active: false }]`) and the expected result `false`.
- It says the test belongs in `test/unit/discount.test.js`.

Fails if line 12 is classified as anything other than a gap, if the input does not distinguish (a single customer, or all active), or if line 5 or line 11 is reported as a gap.
