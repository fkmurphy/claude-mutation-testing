---
type: llm
weight: 2
---

Lines 5 and 11 are discarded as `equivalent`, each with a reason that is correct. Passes if both hold:

- `src/discount.js:5` (`price <= 0` → `price < 0`): the only input that changes branch is a price of exactly 0, and then `Math.round(0 * (1 - rate))` is also 0, so the result is the same.
- `src/discount.js:11` (`customers.length === 0` → `false`): with the early return gone, `[].every(...)` is `true`, which is what the early return gave.

Fails if either is reported as a gap or a bug, or if the reason is missing or wrong (for example, claiming a test kills it).
