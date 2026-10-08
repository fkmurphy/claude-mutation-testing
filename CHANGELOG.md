# Changelog — `mutation` plugin

Format: one entry per published version, with **what changed and why**, not the diff. One
version per batch: whatever is not published yet accumulates under `## Unreleased`.

## Unreleased

- **Integration stage, with one database per runner.** `mutate.sh --integration` takes what the
  unit stage left alive (survivors and NoCoverage), mutates exactly those positions again with
  Stryker's line:column ranges, and runs the integration tests that `affected-tests.mjs` finds for
  their lines. Every runner is a shard: it claims a database of its own through a lock file and
  points the app at it before any test loads. The result adds `killedByIntegration` with the test
  that killed each mutant, and `integration.status` on what is left. Why: settling survivors
  against integration used to be a probe per survivor by hand, and running integration per
  mutant on one shared database gives false kills. Measured on the fixture with two runners on
  one database: the equivalent mutants came out killed by the other runner's data; with shards,
  only the real gap died.
- **Only the survivors go to integration.** Per mutant, Stryker's jest runner loads every test
  related by imports, and an HTTP integration test imports the whole app. Only the survivors,
  with selected tests, keep the database cost to a handful of mutants.
- **`affected-tests.mjs` follows middlewares.** `router.use(guard)` reaches every route of that
  router, and a tsoa `@Middlewares([guard])` reaches the decorated method or every method of the
  decorated class. A router mounting a middleware is no longer read as mounted inside itself,
  which repeated its prefix. Measured on a real authorization middleware reached only over HTTP:
  before, the walk stopped at three module-level references and found no test; now it finds the
  two integration tests that call those routes, with no cut.
- **`affected-tests.mjs` follows CommonJS.** `module.exports = { fn }` and `exports.fn = …`
  are followed to the `require()` that destructures them; the TypeScript language service does not
  link those. It is no longer marked experimental: the integration stage depends on it.
- **The jest config of a stage is built from a JSON of settings** (`assets/jest-config.cjs`),
  shared by both stages instead of generated as text.

## 0.3.0

- **Defaults come from the repo's own unit test script, not from one codebase's conventions.**
  The script is the first of `test-unit`, `test:unit` and `unit` (or `unitTestScript`), followed
  through `pnpm run`/`npm run`/`yarn` references down to the jest call. From there come the
  ignore patterns, the `setupFilesAfterEnv`, the jest `--config` and the environment in front of
  jest (`TZ=UTC jest`). Before, one fixed setup file path was assumed, `TZ=Etc/UTC` was forced
  on every run and probe, and only `test-unit`'s ignore patterns were read. Without a unit script
  the exclusions are `/integration/` and `/e2e/`. Measured on five real services: the same values
  as the old hardcoded ones, and one exclusion the old reading missed.
- **Any jest config format.** The generated config loads the repo's own through jest-config's
  `readInitialOptions`, the loader jest and Stryker use: `.ts`, `.mjs`, `.json`, functions and the
  `jest` key of `package.json`, with paths resolved inside Stryker's sandbox. Needs jest 29.3+.
- **The baseline can no longer pass empty.** It ran `--findRelatedTests --passWithNoTests`; when
  the jest `roots` leave the source out, no test is related by imports and the precondition
  passed without running anything. Now it widens to the whole unit suite (`BASELINE_WIDENED` in
  `warnings`), and an empty suite stops the run (`NO_TESTS`, exit 3). A red Stryker initial run
  is also exit 3 instead of 4. Found by the new end-to-end test.
- **Configuration, optional.** `.mutation.json` in the service directory overrides what used to be
  fixed: which calls are not mutated, the unit-test ignore patterns, the `setupFilesAfterEnv`, the
  excluded mutators and the concurrency. Without the file everything keeps working as in 0.2.0,
  and the run prints each effective value with where it came from (also under `config` in
  `summary.json`). Unknown keys stop the run; `$schema` is accepted and
  `schema/mutation.schema.json` documents every key. Why: the rules were the
  conventions of one codebase written into the script.
- **Log calls are matched by pattern, not by hand-written AST checks.** The defaults keep the
  method list of 0.2.0 (the log levels and `child`) and now also cover `this.logger.*`, which the
  previous matcher missed, chained children (`logger.child({...}).info(...)`), `console.*` and
  optional calls (`logger?.info()`). A pattern accepts `*` for one name and `{a,b}` for one of
  several; a method that is not a log level (`auditLogger.record(...)`) is still mutated.
- **Package manager and Jest config are detected.** pnpm, yarn (classic) or npm by lockfile, looked
  up from `<back-dir>` to the repo root so workspaces work, then by the `packageManager` field of
  `package.json`, then npm. The lockfile is restored on exit even when it lives above
  `<back-dir>`. `jest.config.cjs` and the `jest` key of `package.json` work.
- **`probe.mjs` confirms every `KILLED`.** When the command fails with the mutant it runs again
  without it; if it fails there too (a database that is down, a red test) the verdict is `ERROR`,
  not `KILLED`. A missing binary is `ERROR` and a command that does not finish is `TIMEOUT`
  (exit 3 and 4). Why: an integration probe with the database down read as a kill and discarded a
  real gap as `killed-by-integration`.
- **Inconclusive timeout rechecks are reported.** A recheck that ends in `ERROR` or `TIMEOUT` goes
  to `warnings` as `RECHECK_INCONCLUSIVE` and is counted in `timeoutsInconclusive`. Each recheck
  is bounded by three times the related-tests baseline plus a minute.
- **Settings are validated.** `MUTATE_CONCURRENCY` and `MUTATE_REUSE` must be positive integers.
- **`affected-tests.mjs` warns when the tsconfig excludes the tests** instead of returning an empty
  answer, and fails with a clear message when there is no tsconfig.
- **The agent no longer depends on the marketplace name** to find the scripts when
  `${CLAUDE_SKILL_DIR}` is not substituted: it reads `installed_plugins.json`.
- **More test paths are refused as mutation targets:** `*.test.*`, `*.spec.*`, `__tests__/`, `test/`
  and `tests/`.
- **The plugin has its own tests.** Unit tests with `node:test` (config, script parsing, call
  patterns, probe, reduce), an end-to-end run of `mutate.sh` on a fixture that plants one gap,
  two equivalent mutants, a log call and a failing integration test, CI on Node 22 and 24, and
  `claude plugin eval` cases for when the skill fires (and when it must not) and for the triage
  of the fixture. Node 22 is required, as by Stryker 10.

## 0.2.0

- **`affected-tests.mjs`, experimental.** Selects the tests that reach the changed lines without
  running them: the project's TypeScript language service walks references upward, Express
  routes (hand-written and tsoa-generated) are followed to the tests that call their URL, and
  the places where the walk stops are reported instead of guessed. Measured on one real PR (a
  one-line change): it found the 3 integration tests that execute the line, missed none, and
  added 1 unit test that doesn't — in 45 s, against ~24 min to run every suite. Not wired into
  `mutate.sh` yet: the HTTP-only and worker-only paths are still unmeasured.
- **Load warning.** If another jest is running on the machine, the script says so and
  `summary.json` carries it in `warnings`.
- **What makes a run slow was found, not fixed.** Per mutant, Stryker's jest runner uses
  `--findRelatedTests` on the mutated file, which loads every test file that imports it. On a
  file imported by app-level tests that is hundreds of files per mutant, so every mutant times
  out and only the no-load recheck gives the right result. The fix is handing Stryker the
  selected test files; that is what `affected-tests` is for. A larger `timeoutMS` was tried and
  dropped: it made the same run twice as slow.

## 0.1.0

**First version.** One skill, `mutation-testing`, and one agent that preloads it,
`mutant-triager`.

The mechanical part lives in a script and not in prose, so the agent goes straight to running
it: it installs Stryker only when missing and restores `package.json` and the lockfile on
exit, runs the baseline of the related tests as a precondition, runs Stryker and reduces the
report to what needs triage. What the agent does is the triage.

The unit suite is the repo's own: the test paths excluded from mutation are read from the
`test-unit` script in `package.json`.

Decisions measured on a real service (6 files, 233 mutants):

- **Concurrency 4 with `maxTestRunnerReuse: 20`.** 19.5 min → 7.5 min against concurrency 2.
- **Timeouts are rechecked with no load.** Stryker counts a timeout as detected, and under load
  a slow test runs out of time without the mutant having broken it. At concurrency 6, 58 of 67
  mutants "died" that way and only 2 of 13 survivors were left; at concurrency 2 one survivor
  was hidden that the next run showed.
- **The log ignorer covers the whole statement and `.child(...)`.** Stryker 10 also deletes
  `logger.info(...);` entirely, and the previous version of the ignorer let it through.

Triage measured on two files the skill did not use as examples: 10 survivors, 10 classified
correctly against known results and probing.
