#!/usr/bin/env bash
# End-to-end: runs mutate.sh on a copy of test/fixture and checks the result against what the
# fixture plants. Needs network the first time (npm install of jest, then of Stryker).
#
# Usage: test/e2e/run.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MUTATE="$REPO_DIR/skills/mutation-testing/scripts/mutate.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutation-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; FAILED=1; fi; }
FAILED=0

cp -R "$REPO_DIR/test/fixture" "$WORK/project"
(cd "$WORK/project" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
(cd "$WORK/project" && shasum package.json package-lock.json) > "$WORK/before.sums"

echo "# green fixture"
status=0
"$MUTATE" "$WORK/project" "$WORK/out" src/discount.js > "$WORK/summary.json" 2> "$WORK/stderr.log" || status=$?
check "exit code is 0" "[ $status -eq 0 ]"
check "package.json and the lockfile are restored" "(cd '$WORK/project' && shasum -c '$WORK/before.sums' >/dev/null)"
check "the work directories are removed" "[ ! -e '$WORK/project/.stryker-work' ] && [ ! -e '$WORK/project/.stryker-tmp' ]"
check "the jest config is the repo's .mjs" "grep -q 'jestConfig: \"jest.config.mjs\"' '$WORK/stderr.log'"
check "the environment comes from the unit script" "grep -q 'env: {\"TZ\":\"UTC\"} (\"test-unit\" script)' '$WORK/stderr.log'"
# The fixture's jest roots hold only the tests, so --findRelatedTests sees nothing: the baseline
# has to widen to the whole unit suite instead of passing empty.
check "an empty related baseline widens to the unit suite" "grep -q BASELINE_WIDENED '$WORK/stderr.log'"

node - "$WORK/summary.json" <<'JS' || FAILED=1
const summary = require(process.argv[2]);
const expected = ["5 EqualityOperator", "11 ConditionalExpression", "12 MethodExpression"];
const found = summary.survivors.map(({ line, mutator }) => `${line} ${mutator}`).sort();
const checks = {
  "the survivors are the planted ones (two equivalents and one gap)": JSON.stringify(found) === JSON.stringify(expected.sort()),
  "the log call is ignored": summary.summary.ignored > 0,
  "the integration test is kept out (no red baseline, no kills from it)": summary.summary.killed > 0 && summary.suspiciousKills.length === 0,
  "summary.json carries the effective config": summary.config?.sources?.unitTestIgnorePatterns === '"test-unit" script',
  "the widened baseline is in the warnings": summary.warnings.some((warning) => warning.startsWith("BASELINE_WIDENED")),
};
let failed = false;
Object.entries(checks).forEach(([label, passed]) => {
  console.log(`${passed ? "ok  " : "FAIL"} - ${label}`);
  if (!passed) failed = true;
});
if (!expected.every((item) => found.includes(item))) console.log(`  survivors: ${JSON.stringify(found)}`);
process.exit(failed ? 1 : 0);
JS

echo "# red baseline"
sed -i.bak 's/toBe(80)/toBe(81)/' "$WORK/project/test/unit/discount.test.js"
status=0
"$MUTATE" "$WORK/project" "$WORK/out-red" src/discount.js > /dev/null 2> "$WORK/stderr-red.log" || status=$?
check "exit code is 3" "[ $status -eq 3 ]"
check "it names the failing test" "grep -q 'takes 20% off for a VIP' '$WORK/stderr-red.log'"

echo "# refusals"
status=0
"$MUTATE" "$WORK/project" "$WORK/out-test" test/unit/discount.test.js > /dev/null 2>&1 || status=$?
check "a test file is refused with exit 2" "[ $status -eq 2 ]"

[ "$FAILED" -eq 0 ] && echo "e2e passed" || { echo "e2e failed (logs were in $WORK)"; exit 1; }
