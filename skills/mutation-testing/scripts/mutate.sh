#!/usr/bin/env bash
# Runs Stryker on specific files of a Node/TypeScript service and leaves a reduced result.
#
# Usage: mutate.sh <back-dir> <out-dir> [--typecheck] [--integration] <file> [<file>...]
#   <back-dir>    the service directory, the one with package.json
#   <out-dir>     where stryker.log, mutation.json and summary.json end up (outside the repo)
#   <file>        paths relative to <back-dir>, e.g. src/lib/orders/Order.ts. Accepts a
#                 line range to narrow it down: src/lib/orders/Order.ts:120-180
#   --typecheck   discards the mutants TypeScript would reject (slower)
#   --integration after the unit stage, mutates again what it left alive against the integration
#                 tests that reach those lines, one database per runner (see integration in README)
#
# Configuration: optional <back-dir>/.mutation.json, see README. Without it the defaults and what
# can be detected from the repo apply. The effective values are printed to stderr and kept in
# summary.json.
#
# Output: summary.json on stdout. Exit codes:
#   0 ran · 2 bad usage · 3 red baseline · 4 Stryker failed · 5 could not install
set -uo pipefail

STRYKER_VERSION="10.0.0"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCKFILE=""

fail() { echo "ERROR: $2" >&2; exit "$1"; }

[ $# -ge 3 ] || fail 2 "usage: mutate.sh <back-dir> <out-dir> [--typecheck] [--integration] <file>..."
BACK_DIR="$(cd "$1" 2>/dev/null && pwd)" || fail 2 "$1 does not exist"
mkdir -p "$2" && OUT_DIR="$(cd "$2" && pwd)"
shift 2

TYPECHECK=false
INTEGRATION=false
FILES=()
for arg in "$@"; do
  case "$arg" in
    --typecheck) TYPECHECK=true ;;
    --integration) INTEGRATION=true ;;
    *) FILES+=("$arg") ;;
  esac
done
[ ${#FILES[@]} -gt 0 ] || fail 2 "no files to mutate"

cd "$BACK_DIR" || exit 2
[ -f package.json ] || fail 2 "$BACK_DIR has no package.json"

node "$SKILL_DIR/scripts/resolve-config.mjs" "$BACK_DIR" > "$OUT_DIR/config.json" || exit 2
config() { node -p "const c = require(process.argv[1]).effective; $1" "$OUT_DIR/config.json"; }
PACKAGE_MANAGER="$(config c.packageManager)"
LOCKFILE="$(config c.lockfile)"
node -p "require(process.argv[1]).report.map((line) => 'config · ' + line).join('\\n')" "$OUT_DIR/config.json" >&2
if $INTEGRATION; then
  node -p "require(process.argv[1]).integrationReport.map((line) => 'config · ' + line).join('\\n')" "$OUT_DIR/config.json" >&2
fi

# The environment the unit suite runs with (`TZ=UTC jest ...` in its script, or "env" in
# .mutation.json), for the baseline, Stryker and the rechecks alike.
while IFS= read -r -d '' assignment; do
  export "${assignment?}"
done < <(node -e 'const { env } = require(process.argv[1]).effective; process.stdout.write(Object.entries(env).map(([name, value]) => `${name}=${value}\0`).join(""))' "$OUT_DIR/config.json")

SOURCE_FILES=()
for spec in "${FILES[@]}"; do
  file="${spec%%:*}"
  SOURCE_FILES+=("$file")
  [ -f "$file" ] || fail 2 "$file does not exist (paths are relative to $BACK_DIR)"
  case "$file" in
    *.test.*|*.spec.*|__tests__/*|*/__tests__/*|test/*|*/test/*|tests/*|*/tests/*) fail 2 "$file is a test: mutate the code, not the test" ;;
  esac
done

# The repo's node version, when nvm is available and the current one does not match.
NVMRC=""
[ -f .nvmrc ] && NVMRC=".nvmrc"
[ -z "$NVMRC" ] && [ -f ../.nvmrc ] && NVMRC="../.nvmrc"
if [ -n "$NVMRC" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  wanted="$(tr -d 'v \n' < "$NVMRC")"
  current="$(node -v 2>/dev/null | tr -d 'v')"
  if [ "${current%%.*}" != "${wanted%%.*}" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" && nvm use --silent "$wanted" >/dev/null || fail 5 "nvm could not activate node $wanted"
  fi
fi

WORK_DIR=".stryker-work"
SNAPSHOT_DIR="$OUT_DIR/snapshot"

cleanup() {
  rm -rf "$WORK_DIR" .stryker-tmp
  if [ -d "$SNAPSHOT_DIR" ]; then
    cp "$SNAPSHOT_DIR/package.json" package.json
    # The lockfile can live above <back-dir> in a workspace, so the snapshot uses a fixed name.
    if [ -f "$SNAPSHOT_DIR/lockfile" ]; then cp "$SNAPSHOT_DIR/lockfile" "$LOCKFILE"; else rm -f "$LOCKFILE"; fi
    rm -rf "$SNAPSHOT_DIR"
  fi
}
trap cleanup EXIT

# Frozen installs only when there is a lockfile to freeze against.
install_dependencies() {
  case "$PACKAGE_MANAGER" in
    pnpm) if [ -f "$LOCKFILE" ]; then pnpm install --frozen-lockfile --prefer-offline; else pnpm install; fi ;;
    yarn) if [ -f "$LOCKFILE" ]; then yarn install --frozen-lockfile; else yarn install; fi ;;
    npm) if [ -f "$LOCKFILE" ]; then npm ci --prefer-offline; else npm install; fi ;;
  esac
}
add_dev_dependencies() {
  case "$PACKAGE_MANAGER" in
    pnpm) pnpm add -D "$@" ;;
    yarn) yarn add -D "$@" ;;
    npm) npm install -D "$@" ;;
  esac
}

# The repo's dependencies. A freshly created worktree has no node_modules.
if [ ! -d node_modules ]; then
  echo "installing the repo's dependencies with $PACKAGE_MANAGER..." >&2
  install_dependencies >"$OUT_DIR/install.log" 2>&1 \
    || fail 5 "$PACKAGE_MANAGER install failed, see $OUT_DIR/install.log"
fi

# Stryker, only when missing. package.json and the lockfile are restored on exit: the install
# stays in node_modules and never reaches a commit.
PACKAGES=(core jest-runner api)
$TYPECHECK && PACKAGES+=(typescript-checker)
MISSING=()
for package in "${PACKAGES[@]}"; do
  [ -f "node_modules/@stryker-mutator/$package/package.json" ] || MISSING+=("@stryker-mutator/$package@$STRYKER_VERSION")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "installing ${MISSING[*]}..." >&2
  mkdir -p "$SNAPSHOT_DIR"
  cp package.json "$SNAPSHOT_DIR/"
  [ -f "$LOCKFILE" ] && cp "$LOCKFILE" "$SNAPSHOT_DIR/lockfile"
  add_dev_dependencies "${MISSING[@]}" >"$OUT_DIR/install.log" 2>&1 \
    || fail 5 "could not install Stryker, see $OUT_DIR/install.log"
fi

# The config lives inside the repo because Stryker copies the project into a sandbox and jest
# has to find it there, through relative paths.
mkdir -p "$WORK_DIR"
ASSETS=(log-ignorer.mjs call-patterns.mjs load-jest-config.cjs jest-config.cjs claim-shard.cjs)
cp "${ASSETS[@]/#/$SKILL_DIR/assets/}" "$WORK_DIR/"
config 'JSON.stringify(c.ignoreCalls)' > "$WORK_DIR/ignore-calls.json"

# The unit stage's jest config: the repo's own, plus the unit script's setup files and exclusions.
node -e '
const { effective } = require(process.argv[1]);
const settings = {
  jestConfig: effective.jestConfig,
  setupFilesAfterEnv: effective.setupFilesAfterEnv,
  testPathIgnorePatterns: effective.unitTestIgnorePatterns,
  testMatch: null,
  selectedTests: null,
  shard: null,
};
require("node:fs").writeFileSync(process.argv[2], JSON.stringify(settings, null, 2));
' "$OUT_DIR/config.json" "$WORK_DIR/unit.json"
echo 'module.exports = require("./jest-config.cjs")(__dirname, "unit.json");' > "$WORK_DIR/jest.config.cjs"

# Precondition: the suite covering these files passes unmutated. With a red or flaky
# baseline, every mutant counts as killed and the result is noise.
# Another jest on the machine steals CPU: tests run slower, more mutants time out, and the
# run takes longer. Nothing to fix here, but the result has to say it.
: > "$OUT_DIR/warnings.txt"
OTHER_JEST="$(pgrep -f "jest/bin/jest|jest-worker" | tr '\n' ' ')"
if [ -n "$OTHER_JEST" ]; then
  echo "LOAD_WARNING: another jest is running (pids $OTHER_JEST). Timeouts and runtime will be inflated." | tee -a "$OUT_DIR/warnings.txt" >&2
fi

red_baseline() {
  echo "RED_BASELINE: $1 Nothing Stryker says is valid." >&2
  grep -E "✕|●|Tests:" "$2" | head -30 >&2
  exit 3
}
run_baseline() {
  node_modules/.bin/jest -c "$WORK_DIR/jest.config.cjs" --passWithNoTests --silent "$@" >"$OUT_DIR/baseline.log" 2>&1
}

echo "baseline of the related tests..." >&2
BASELINE_START=$(date +%s)
run_baseline --findRelatedTests "${SOURCE_FILES[@]}" || red_baseline "the related tests fail without any mutation." "$OUT_DIR/baseline.log"
# --findRelatedTests only sees source files inside the jest roots. When it finds nothing, an empty
# baseline would pass without proving anything: the whole unit suite, which Stryker's initial
# run executes anyway, is the precondition instead.
if grep -q "No tests found" "$OUT_DIR/baseline.log"; then
  echo "BASELINE_WIDENED: no test is related to the files by imports (are they outside the jest roots?): the baseline ran the whole unit suite." \
    | tee -a "$OUT_DIR/warnings.txt" >&2
  run_baseline || red_baseline "the unit suite fails without any mutation." "$OUT_DIR/baseline.log"
  grep -q "No tests found" "$OUT_DIR/baseline.log" && fail 3 "NO_TESTS: the unit suite has no tests with this config (see $OUT_DIR/baseline.log)"
fi
BASELINE_SECONDS=$(( $(date +%s) - BASELINE_START ))

node - "$WORK_DIR/stryker.config.json" "$OUT_DIR/mutation.json" "$TYPECHECK" "$OUT_DIR/config.json" "${FILES[@]}" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [configPath, reportPath, typecheck, resolvedPath, ...files] = process.argv.slice(2);
const { effective } = JSON.parse(readFileSync(resolvedPath, "utf8"));
const withTypecheck = typecheck === "true";
const config = {
  packageManager: effective.packageManager,
  testRunner: "jest",
  plugins: ["@stryker-mutator/jest-runner", ...(withTypecheck ? ["@stryker-mutator/typescript-checker"] : [])],
  appendPlugins: ["./.stryker-work/log-ignorer.mjs"],
  ignorers: ["log-calls"],
  jest: { projectType: "custom", configFile: ".stryker-work/jest.config.cjs", enableFindRelatedTests: true },
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  concurrency: effective.concurrency,
  maxTestRunnerReuse: effective.maxTestRunnerReuse,
  mutate: files,
  ...(effective.excludedMutations.length > 0 ? { mutator: { excludedMutations: effective.excludedMutations } } : {}),
  reporters: ["json"],
  jsonReporter: { fileName: reportPath },
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  incremental: false,
  thresholds: { high: 80, low: 60, break: null },
  ...(withTypecheck ? { checkers: ["typescript"], tsconfigFile: "tsconfig.json" } : {}),
};
writeFileSync(configPath, JSON.stringify(config, null, 2));
JS

echo "running Stryker on ${#FILES[@]} file(s)..." >&2
START=$(date +%s)
if ! node_modules/.bin/stryker run "$WORK_DIR/stryker.config.json" >"$OUT_DIR/stryker.log" 2>&1; then
  if grep -q "There were failed tests in the initial test run" "$OUT_DIR/stryker.log"; then
    red_baseline "Stryker's initial run, which executes the whole unit suite, has failing tests." "$OUT_DIR/stryker.log"
  fi
  echo "Stryker failed. Last lines of $OUT_DIR/stryker.log:" >&2
  tail -25 "$OUT_DIR/stryker.log" >&2
  exit 4
fi
echo "Stryker took $(( $(date +%s) - START ))s" >&2

# A timeout under load counts as detected and can hide a survivor. Each one runs again alone,
# with no load. "Hit limit reached" ones are real infinite loops and stay as they are.
node - "$OUT_DIR/mutation.json" > "$OUT_DIR/timeouts.tsv" <<'JS'
const report = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const testFileById = new Map(
  Object.entries(report.testFiles ?? {}).flatMap(([file, { tests }]) => tests.map((test) => [test.id, file])),
);
Object.values(report.files)
  .flatMap(({ mutants }) => mutants)
  .filter((mutant) => mutant.status === "Timeout" && !/Hit limit/i.test(mutant.statusReason ?? ""))
  .forEach((mutant) => {
    const testFiles = [...new Set((mutant.coveredBy ?? []).map((id) => testFileById.get(id)).filter(Boolean))];
    if (testFiles.length > 0) console.log([mutant.id, ...testFiles].join("\t"));
  });
JS
: > "$OUT_DIR/recheck.tsv"
if [ -s "$OUT_DIR/timeouts.tsv" ]; then
  # Each recheck runs a few test files alone, so the whole related baseline is a generous bound;
  # without one, a mutant that hangs without reaching Stryker's hit limit would stall the run.
  RECHECK_TIMEOUT_MS="${PROBE_TIMEOUT_MS:-$(( (BASELINE_SECONDS * 3 + 60) * 1000 ))}"
  echo "rechecking $(wc -l < "$OUT_DIR/timeouts.tsv" | tr -d ' ') timeout(s) with no load (up to $(( RECHECK_TIMEOUT_MS / 1000 ))s each)..." >&2
  while IFS=$'\t' read -r mutant_id test_files; do
    # shellcheck disable=SC2086
    probe_output="$(PROBE_TIMEOUT_MS="$RECHECK_TIMEOUT_MS" node "$SKILL_DIR/scripts/probe.mjs" "$OUT_DIR/mutation.json" . "$mutant_id" -- \
      node_modules/.bin/jest -c "$WORK_DIR/jest.config.cjs" --silent $test_files | head -1)"
    verdict="${probe_output%% *}"
    printf '%s\t%s\n' "$mutant_id" "$verdict" >> "$OUT_DIR/recheck.tsv"
    case "$verdict" in
      KILLED|SURVIVED) ;;
      *) echo "RECHECK_INCONCLUSIVE: ${probe_output:-mutant $mutant_id: probe printed nothing}. It stays counted as a timeout." | tee -a "$OUT_DIR/warnings.txt" >&2 ;;
    esac
  done < "$OUT_DIR/timeouts.tsv"
fi

if $INTEGRATION; then
  node "$SKILL_DIR/scripts/integration-stage.mjs" "$OUT_DIR" "$BACK_DIR" "$BACK_DIR/$WORK_DIR" "$SKILL_DIR" \
    || echo "INTEGRATION_FAILED: the integration stage crashed; the unit result stands." | tee -a "$OUT_DIR/warnings.txt" >&2
fi

node "$SKILL_DIR/scripts/reduce.mjs" "$OUT_DIR/mutation.json" "$OUT_DIR/recheck.tsv" "$OUT_DIR/warnings.txt" "$OUT_DIR/config.json" "$OUT_DIR/integration" \
  | tee "$OUT_DIR/summary.json"
