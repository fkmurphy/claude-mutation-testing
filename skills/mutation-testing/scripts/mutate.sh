#!/usr/bin/env bash
# Runs Stryker on specific files of a Node/TypeScript service and leaves a reduced result.
#
# Usage: mutate.sh <back-dir> <out-dir> [--typecheck] <file> [<file>...]
#   <back-dir>    the service directory with package.json and a jest config
#   <out-dir>     where stryker.log, mutation.json and summary.json end up (outside the repo)
#   <file>        paths relative to <back-dir>, e.g. src/lib/orders/Order.ts. Accepts a
#                 line range to narrow it down: src/lib/orders/Order.ts:120-180
#   --typecheck   discards the mutants TypeScript would reject (slower)
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

[ $# -ge 3 ] || fail 2 "usage: mutate.sh <back-dir> <out-dir> [--typecheck] <file>..."
BACK_DIR="$(cd "$1" 2>/dev/null && pwd)" || fail 2 "$1 does not exist"
mkdir -p "$2" && OUT_DIR="$(cd "$2" && pwd)"
shift 2

TYPECHECK=false
FILES=()
for arg in "$@"; do
  case "$arg" in
    --typecheck) TYPECHECK=true ;;
    *) FILES+=("$arg") ;;
  esac
done
[ ${#FILES[@]} -gt 0 ] || fail 2 "no files to mutate"

cd "$BACK_DIR" || exit 2
[ -f package.json ] || fail 2 "$BACK_DIR has no package.json"

node "$SKILL_DIR/scripts/resolve-config.mjs" "$BACK_DIR" > "$OUT_DIR/config.json" || exit 2
config() { node -p "const c = require('$OUT_DIR/config.json').effective; $1" ; }
PACKAGE_MANAGER="$(config c.packageManager)"
LOCKFILE="$(config c.lockfile)"
JEST_CONFIG_FILE="$(config 'c.jestConfigFile ?? ""')"
node -p "require('$OUT_DIR/config.json').report.map((line) => 'config · ' + line).join('\\n')" >&2

SOURCE_FILES=()
for spec in "${FILES[@]}"; do
  file="${spec%%:*}"
  SOURCE_FILES+=("$file")
  [ -f "$file" ] || fail 2 "$file does not exist (paths are relative to $BACK_DIR)"
  case "$file" in
    *.test.ts|*.spec.ts|src/test/*) fail 2 "$file is a test: mutate the code, not the test" ;;
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
    if [ -n "$LOCKFILE" ]; then
      if [ -f "$SNAPSHOT_DIR/$LOCKFILE" ]; then cp "$SNAPSHOT_DIR/$LOCKFILE" "$LOCKFILE"; else rm -f "$LOCKFILE"; fi
    fi
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
  [ -f "$LOCKFILE" ] && cp "$LOCKFILE" "$SNAPSHOT_DIR/"
  add_dev_dependencies "${MISSING[@]}" >"$OUT_DIR/install.log" 2>&1 \
    || fail 5 "could not install Stryker, see $OUT_DIR/install.log"
fi

# The config lives inside the repo because Stryker copies the project into a sandbox and jest
# has to find it there, through relative paths.
mkdir -p "$WORK_DIR"
cp "$SKILL_DIR/assets/log-ignorer.mjs" "$WORK_DIR/"
config 'JSON.stringify(c.ignoreCalls)' > "$WORK_DIR/ignore-calls.json"

if [ -n "$JEST_CONFIG_FILE" ]; then
  JEST_BASE="require(\"../$JEST_CONFIG_FILE\")"
else
  JEST_BASE="require(\"../package.json\").jest"
fi
SETUP_AFTER_ENV="$(config 'JSON.stringify(c.setupFiles)')"
UNIT_IGNORES="$(config 'JSON.stringify(c.unitTestIgnorePatterns)')"

cat > "$WORK_DIR/jest.config.cjs" <<JS
const path = require("node:path");
const base = $JEST_BASE;

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, ".."),
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), ...${SETUP_AFTER_ENV}],
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? ["/node_modules/"]), ...${UNIT_IGNORES}],
};
JS

export TZ=Etc/UTC

# Precondition: the suite covering these files passes unmutated. With a red or flaky
# baseline, every mutant counts as killed and the result is noise.
# Another jest on the machine steals CPU: tests run slower, more mutants time out, and the
# run takes longer. Nothing to fix here, but the result has to say it.
: > "$OUT_DIR/warnings.txt"
OTHER_JEST="$(pgrep -f "jest/bin/jest|jest-worker" | tr '\n' ' ')"
if [ -n "$OTHER_JEST" ]; then
  echo "LOAD_WARNING: another jest is running (pids $OTHER_JEST). Timeouts and runtime will be inflated." | tee -a "$OUT_DIR/warnings.txt" >&2
fi

echo "baseline of the related tests..." >&2
if ! node_modules/.bin/jest -c "$WORK_DIR/jest.config.cjs" --findRelatedTests "${SOURCE_FILES[@]}" \
    --passWithNoTests --silent >"$OUT_DIR/baseline.log" 2>&1; then
  echo "RED_BASELINE: the related tests fail without any mutation. Nothing Stryker says is valid." >&2
  grep -E "✕|●|Tests:" "$OUT_DIR/baseline.log" | head -30 >&2
  exit 3
fi

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
  echo "rechecking $(wc -l < "$OUT_DIR/timeouts.tsv" | tr -d ' ') timeout(s) with no load..." >&2
  while IFS=$'\t' read -r mutant_id test_files; do
    # shellcheck disable=SC2086
    verdict="$(node "$SKILL_DIR/scripts/probe.mjs" "$OUT_DIR/mutation.json" . "$mutant_id" -- \
      node_modules/.bin/jest -c "$WORK_DIR/jest.config.cjs" --silent $test_files | head -1 | cut -d' ' -f1)"
    printf '%s\t%s\n' "$mutant_id" "$verdict" >> "$OUT_DIR/recheck.tsv"
  done < "$OUT_DIR/timeouts.tsv"
fi

node "$SKILL_DIR/scripts/reduce.mjs" "$OUT_DIR/mutation.json" "$OUT_DIR/recheck.tsv" "$OUT_DIR/warnings.txt" "$OUT_DIR/config.json" | tee "$OUT_DIR/summary.json"
