# Changelog — `mutation` plugin

Format: one entry per published version, with **what changed and why**, not the diff. One
version per batch: whatever is not published yet accumulates under `## Unreleased`.

## Unreleased

—

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
