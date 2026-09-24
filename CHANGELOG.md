# Changelog — `mutation` plugin

Format: one entry per published version, with **what changed and why**, not the diff. One
version per batch: whatever is not published yet accumulates under `## Unreleased`.

## Unreleased

—

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
