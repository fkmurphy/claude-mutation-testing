# claude-mutation-testing

A Claude Code plugin that answers one question about a Node/TypeScript codebase: **do these tests
actually protect this code?**

Coverage says a line ran. It does not say a test would notice if the line were wrong. Mutation
testing changes the code one small edit at a time (`<=` → `<`, `every` → `some`, a deleted
statement) and checks whether some test fails. A mutant that no test kills is a **survivor**.

Survivors are candidates, not findings. In practice about half of them are *equivalent*: no
input allowed by the contract tells the mutant apart from the original. Reading a raw Stryker
report means sorting those out by hand. This plugin does the mechanical part in one command and
gives the sorting to an agent. You get back only the real gaps, each with the concrete input that
exposes it, and one line explaining every survivor that was discarded.

## What's inside

| Piece | What it does |
|---|---|
| Skill `mutation-testing` | How to run, what is already filtered out, the verdicts and the output format |
| Agent `mutant-triager` | Runs the script first, triages every survivor, probes what reading does not settle, returns only the result |
| `scripts/mutate.sh` | Runs everything: config, Stryker install if missing, baseline, Stryker, timeout rechecks, reduced report |
| `scripts/probe.mjs` | Applies one mutant, runs any command (an integration test, a temporary test) and restores the file |
| `scripts/affected-tests.mjs` | Finds the tests that reach some lines without running anything: TypeScript references, Express and tsoa routes, CommonJS `require`. Picks the tests of the integration stage |

## Install

```
/plugin marketplace add fkmurphy/claude-mutation-testing
/plugin install mutation@claude-mutation-testing
```

Restart Claude Code after installing or updating.

## Use

Ask in plain words, in English or Spanish:

> do the tests of `src/orders/discount.ts` protect anything?
>
> validá los tests de este PR por mutación

Or call the agent from another agent or a review: `mutation:mutant-triager` with the service
directory and the files. Files accept a line range, so a review can mutate only the diff:
`src/orders/discount.ts:120-180`.

The result looks like this (from the fixture in `test/fixture`):

```markdown
**1 gap, 0 bugs, 0 unclear** out of 3 survivors · score 78.57% · 19 mutants in 1 files

### Gaps
1. `src/discount.js:12` — `every` and `some` are never told apart: every test passes a
   one-element array. Input: `allActive([{ active: true }, { active: false }])` must be `false`.
   Belongs in `test/unit/discount.test.js`.

### Discarded
- `src/discount.js:5` · equivalent · with `price < 0`, a price of 0 goes on to `Math.round(0 * …)`, which is also 0
- `src/discount.js:11` · equivalent · `[].every(...)` is already `true`, so the early return is redundant
```

## How it works

1. **Configuration.** Read from the repo's unit test script, followed down to its jest call (see
   below), with an optional `.mutation.json` on top. The run prints each value and where it came
   from.
2. **Stryker, only if missing.** Installs `@stryker-mutator/*` 10.0.0 with the repo's package
   manager and restores `package.json` and the lockfile on exit: nothing reaches a commit.
3. **Baseline.** Runs the tests related to the files, unmutated. If they fail, every mutant would
   count as killed and the result would be noise, so the run stops (exit 3).
4. **Stryker** on the given files or ranges, against the unit suite only. Log calls are not
   mutated; neither is code that only runs when a module loads.
5. **Timeout rechecks.** Stryker counts a timeout as a kill, and under parallel load a slow test
   times out without the mutant having broken it. Each timeout runs again alone, and the ones that
   pass come back as survivors.
6. **Reduction.** The ~600 KB Stryker report becomes a `summary.json` of a few KB: survivors with
   their line and covering tests, uncovered lines grouped by file, suspicious kills, warnings.
7. **Triage**, by the agent. For each survivor: is there a realistic input that tells the original
   from the mutant? Verdicts: `gap`, `bug` (the mutant behaves better), `equivalent`,
   `killed-by-integration`, `noise`, `unclear`. What reading does not settle gets probed.

8. **Integration stage**, with `--integration`. What the unit stage left alive (survivors and
   uncovered mutants) is mutated again at exactly those positions, against the integration tests
   that reach their lines. Every Stryker runner is a **shard** with its own database, so tests that
   clean tables never wipe each other's data. See below.

`probe.mjs` counts a kill only when the command fails with the mutant **and passes without it**.
A probe against a database that is down fails both ways, and it reports `ERROR`. It never reports
`KILLED` in that case.

## Requirements

- Node 22 or newer (Stryker 10's own requirement)
- Jest 29.3 or newer, with any config format jest reads: `jest.config.{js,cjs,mjs,ts,json}`, the
  `jest` key of `package.json`, or a function
- pnpm, npm or yarn classic (1.x). Yarn Berry with Plug'n'Play has no `node_modules` to run from
- A throwaway git worktree is recommended: the scripts run the repo's install and tests, and
  `probe.mjs` edits files in place while it runs

## Configuration

Nothing is required. The unit test script is the first of `test-unit`, `test:unit` and `unit`
in `package.json`. Its `pnpm run` / `npm run` / `yarn` references are followed down to the jest
call, and from there the plugin reads:

| From the jest call | Used as |
|---|---|
| `--testPathIgnorePatterns` | the paths kept out of the run, usually the integration suite |
| `--setupFilesAfterEnv` | added to the jest config's setup files |
| `--config` / `-c` | the jest config to load |
| `NAME=value` in front of jest | the environment of the baseline, Stryker and the rechecks |

Without a unit script, `/integration/` and `/e2e/` are excluded and no environment is added.

To change anything, add a `.mutation.json` in the service directory. Each key overrides only its
own value. Editors validate it with the bundled schema:

```json
{
  "$schema": "https://raw.githubusercontent.com/fkmurphy/claude-mutation-testing/main/schema/mutation.schema.json",
  "unitTestIgnorePatterns": ["/integration/", "/src/models/subscribers/"],
  "ignoreCalls": ["audit.{info,warn}"],
  "env": { "TZ": "UTC" }
}
```

| Key | Default |
|---|---|
| `unitTestScript` | the first of `test-unit`, `test:unit`, `unit` |
| `unitTestIgnorePatterns` | from the unit script; without one, `/integration/`, `/e2e/` |
| `setupFilesAfterEnv` | from the unit script; relative to the service directory, or starting with `<rootDir>` |
| `env` | the variables in front of jest in the unit script |
| `ignoreCalls` | the log levels (`info`, `warn`, `error`, `debug`, `trace`, `fatal`, `child`) on `*logger`, `this.*logger`, `*logger.child()` and `getLogger()`, plus `console.*`. Yours are **added**; `replaceDefaultIgnoreCalls: true` uses only yours. `*` is one name and never crosses a dot or a call; `{a,b}` is one of the names |
| `excludedMutations` | none: every Stryker mutator runs |
| `concurrency`, `maxTestRunnerReuse` | 4 and 20, measured on a real service; also `MUTATE_CONCURRENCY` and `MUTATE_REUSE` |
| `packageManager` | the closest lockfile up to the repo root, then the `packageManager` field of `package.json`, then npm |

## Integration stage

```bash
mutate.sh <back-dir> <out-dir> --integration src/orders/discount.ts:120-180
```

The unit stage is fast and runs every mutant. The integration stage only gets what the unit
stage left alive, usually a handful of mutants, so the database is paid for a few of them and not
for hundreds:

1. `affected-tests.mjs` finds the tests that reach the surviving lines, and of those, the ones
   the integration script's `--testMatch` calls integration tests.
2. One database per runner (a shard) is created from the template with the repo's own command,
   and dropped at the end if `drop` is set.
3. Each Stryker runner claims a free shard through a lock file and points the app at it, by
   setting the variable named in `database.env` before any test module loads.
4. The baseline of those tests runs unmutated first. If it fails, the stage is skipped with a
   warning and the unit result stands.
5. Stryker mutates exactly the surviving positions. Timeouts are rechecked with no load, as in the
   unit stage.

The result keeps the unit stage's numbers and adds `killedByIntegration` (each with the test that
killed it), `integration.status` on every remaining survivor, and `scoreWithIntegration`.

The integration suite is read from its script, the first of `test-integration`,
`test:integration` and `integration`, like the unit one. Only the database needs configuring.
For a Postgres in a local container:

```json
{
  "integration": {
    "concurrency": 2,
    "database": {
      "env": "DB_NAME",
      "template": "app_test",
      "prepare": "docker exec postgres psql -U app -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS \\\"$MUTATION_DB\\\"\" -c \"CREATE DATABASE \\\"$MUTATION_DB\\\" TEMPLATE \\\"$MUTATION_DB_TEMPLATE\\\"\"",
      "drop": "docker exec postgres psql -U app -d postgres -c \"DROP DATABASE IF EXISTS \\\"$MUTATION_DB\\\"\""
    }
  }
}
```

`prepare` and `drop` are shell commands run from the service directory with `MUTATION_DB` (the
shard's name, `<template>_mutation_<n>`) and `MUTATION_DB_TEMPLATE` set. A Postgres template
cannot have open connections while it is copied, so nothing else should be using the test database
during the run.

| `integration` key | Default |
|---|---|
| `testScript` | the first of `test-integration`, `test:integration`, `integration` |
| `testMatch`, `setupFilesAfterEnv`, `env` | from the integration script |
| `concurrency` | 2 shards with a database; 1 runner without one |
| `database.env`, `database.template`, `database.prepare` | required for shards |
| `database.drop` | none: the shard databases are kept and recreated by `prepare` next time |

## Exit codes and warnings

| `mutate.sh` exit | Meaning |
|---|---|
| 0 | ran: triage `summary.json` |
| 2 | bad usage or a config it cannot use; the message says which |
| 3 | red baseline: tests fail without any mutation. Also `NO_TESTS`: the unit suite is empty with this config |
| 4 | Stryker failed: the tail of `stryker.log` is printed |
| 5 | the install failed: see `install.log` |

| Warning in `summary.json` | Meaning |
|---|---|
| `LOAD_WARNING` | another jest was running on the machine: runtimes and timeouts are inflated |
| `RECHECK_INCONCLUSIVE` | a timeout could not be rechecked and stays counted as a kill |
| `INTEGRATION_SKIPPED`, `INTEGRATION_NO_TESTS`, `INTEGRATION_BASELINE_RED`, `INTEGRATION_FAILED` | the integration stage did not run or did not finish; the message says why, and the unit result stands |
| `SELECTOR_INCOMPLETE` | the static walk that picks the integration tests stopped somewhere; tests behind that point did not run |
| `BASELINE_WIDENED` | no test is related to the files by imports (often jest `roots` that leave the source out), so the baseline ran the whole unit suite |

## Limitations

- **The integration stage needs the repo to say how to copy its test database**
  (`integration.database`). Without it the stage still runs, on a single runner: correct, slow.
- **The test selection is static.** Where the walk stops (a method shared by many classes, a queue
  worker, a reference at module level) the tests behind it do not run, and the run says so
  (`SELECTOR_INCOMPLETE`).
- **Equivalent mutants cannot be marked.** Stryker forgets them between runs. The agent explains
  each one in one line, so a second run is reading, not thinking.
- **Mutation does not see a badly designed algorithm.** It perturbs the code that was written.
  About a quarter of real faults couple to no mutant at all (Just et al., FSE 2014).
- **The unit stage is slow on widely imported files.** Per mutant, Stryker's jest runner loads
  every unit test that imports the mutated file. On a file imported by app-level tests most
  mutants time out, and only the recheck gives the right answer. The integration stage does not
  have this problem: it hands Stryker the selected tests.
- A jest config with `projects` is loaded, but the plugin's ignore patterns and setup files reach
  only the top level.

## Development

```bash
npm test            # unit tests (node:test, no dependencies)
npm run test:e2e    # mutate.sh on test/fixture; needs network the first time
npm run lint        # shellcheck and syntax
claude plugin eval . --runs 3   # the skill and agent evals in evals/
```

The fixture plants one real gap, two equivalent mutants, a log call and an integration test that
always fails. The e2e checks that exactly those three survivors come back, and that the
integration test is kept out.

See `CHANGELOG.md` for what changed and why.

## License

MIT, see `LICENSE`.
