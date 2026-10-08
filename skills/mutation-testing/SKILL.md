---
name: mutation-testing
description: Checks whether the tests of a Node/TypeScript service actually protect the code, by running Stryker on specific files and triaging the survivors until only real gaps are left. Use when the user says "validate the tests with mutation", "do these tests protect anything?", "run Stryker", "mutation testing on X", "check whether the tests are tautological", or their Spanish equivalents ("validá los tests por mutación", "¿estos tests protegen algo?", "corré Stryker"), or when a review needs to claim that a code path has no safety net. Unit tests only; integration is used to settle survivors, not to mutate.
---

# Mutation testing

Stryker changes the code one mutation at a time and runs the tests that cover it. If none fails, the mutant **survives**. A survivor is not a gap: it is a candidate. In the first measured run, 12 of 21 survivors were equivalent. The value of this skill is in the triage, not in the score.

## Run

One command does everything: installs Stryker if missing (leaving `package.json` and the lockfile untouched on exit), builds the config, runs the precondition and reduces the report.

```bash
${CLAUDE_SKILL_DIR}/scripts/mutate.sh <back-dir> <out-dir> <file>...
```

- `<back-dir>`: the service directory, the one with `package.json`. Ideally inside a throwaway worktree.
- `<out-dir>`: outside the repo, e.g. the session scratchpad.
- `<file>`: paths relative to `<back-dir>`. Code, never tests. Accepts a range to narrow it to what changed: `src/lib/orders/Order.ts:120-180`. In a review, the diff's range.
- `--typecheck`: discards mutants TypeScript would reject. Slower.
- `--integration`: after the unit stage, an integration stage settles what it left alive. See below. Use it when `<back-dir>/.mutation.json` has an `integration.database`; without one the stage runs on a single runner, which is correct but slow.

Prints `summary.json` to stdout and leaves it in `<out-dir>`, next to `mutation.json` (the full report, used for probing) and the logs. `summary.json` carries under `config` the effective settings and where each one came from: the repo's unit test script, a default, or the repo's `.mutation.json`. Most come from the unit script (`test-unit`, `test:unit` or `unit`), followed through its `pnpm run`/`npm run`/`yarn` references down to the jest call: its `--testPathIgnorePatterns`, its `--setupFilesAfterEnv`, its `--config` and the variables in front of it (`TZ=UTC jest`). If a value looks wrong, the fix is a `.mutation.json` in `<back-dir>`, not a different command.

Everything in `warnings` goes in the output:

- `LOAD_WARNING`: another jest is running on the machine. Runtimes and timeouts are inflated.
- `RECHECK_INCONCLUSIVE`: a timeout could not be rechecked (`ERROR` or `TIMEOUT` from the probe). It stays counted as detected, so it may hide a survivor.
- `INTEGRATION_SKIPPED`, `INTEGRATION_NO_TESTS`, `INTEGRATION_BASELINE_RED`, `INTEGRATION_FAILED`: the integration stage did not run or did not finish, and the message says why. The unit result stands. Survivors are then settled by probing, as without `--integration`.
- `SELECTOR_INCOMPLETE`: the static walk that picks the integration tests stopped somewhere (a method many classes share, a reference at module level). Tests reached only through there did not run, so a survivor of both stages may still die in one of them: probe before calling it a `gap`.
- `BASELINE_WIDENED`: no test is related to the files by imports, usually because the jest `roots` leave the source out, so the precondition ran the whole unit suite. The result is still valid; runs are slower.

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | ran | triage |
| 2 | bad usage | fix the arguments |
| 3 | **red baseline** | stop. With tests failing unmutated, every mutant counts as killed and the result is noise. Report which tests fail. If they need infrastructure (a database), they are integration tests outside the excluded paths: say so, and that `unitTestIgnorePatterns` in `.mutation.json` keeps them out. Also `NO_TESTS`: the unit suite is empty with this config |
| 4 | Stryker failed | read the tail of `stryker.log` it prints |
| 5 | could not install | read `install.log` |

It takes about **2.5 s per mutant** at the default concurrency (4), plus the dependency install if the worktree is new. A typical file has 20 to 100 mutants. For many files, say so before running.

## Already filtered out

No need to discard these again:

- **Logs.** By default, the log-level methods (`info`, `warn`, `error`, `debug`, `trace`, `fatal`, `child`) called on any name ending in `logger` (`logger`, `baseLogger`, `this.logger`, `getLogger()`, `x.child(...)`), plus `console.*`, and the statement that contains them. Instrumentation is not business logic. The repo can add or replace patterns: the effective list is `config.effective.ignoreCalls`. A method that is not a log level (`auditLogger.record(...)`) is mutated.
- **Static code.** Code that only runs when the module loads (`ignoreStatic`). A chosen blind spot: module-level config is not measured.
- **Integration, in the unit stage.** The unit stage excludes the test paths the unit script excludes (`config.effective.unitTestIgnorePatterns`; without a unit script, `/integration/` and `/e2e/`). Each mutant would cost seconds of database there.
- **What integration kills, with `--integration`.** The integration stage takes only what the unit stage left alive (survivors and NoCoverage), mutates exactly those positions again, and runs the integration tests that reach their lines (found by `affected-tests.mjs`, not by imports). Every Stryker runner is a shard with its own database, copied from `integration.database.template`, so tests that clean tables never wipe each other's data. What it kills is in `killedByIntegration`, with the test that killed it: those are already settled, list them as `killed-by-integration` without probing. A survivor with `integration.status: "Survived"` survived both stages, so it is the strongest gap candidate. With `"NoCoverage"` no integration test reaches it either.
- **Timeouts under load.** Stryker counts a timeout as detected, and with several runners in parallel a slow test runs out of time without the mutant having broken it: at concurrency 6, 58 of 67 mutants "died" that way and only 2 of 13 survivors were left. The script reruns each timeout alone, with no load, and the one that passes goes back to the list with `revivedFromTimeout: true`. `Hit limit reached` ones are real infinite loops and stay as detected.

## Triage each survivor

For each one, read the whole function and the tests in `coveredBy`. Survivors on the same line or function are analyzed together: they usually share a cause.

There is one question: **is there a realistic input, allowed by the contract, that tells the original apart from the mutant?**

| Verdict | When | What it carries |
|---|---|---|
| `gap` | An input tells them apart, and no test uses it | **the concrete input** and the test where it belongs |
| `bug` | The mutant behaves better than the original | the case where the original fails |
| `equivalent` | No allowed input tells them apart | **why**: which layer or which semantics absorbs it |
| `killed-by-integration` | An integration test kills it (from `killedByIntegration`, or probed) | the test that kills it |
| `noise` | Changes something observable that is not contract | why it is not contract |
| `unclear` | Reading and cheap probing were not enough | what is missing to decide |

### Forms of equivalence already seen

Recognizing them saves most of the work:

- **A guard another layer already guarantees.** `query !== null` next to `isObject(query)`, which is already `false` for `null`. An `isString` before a `try` whose `catch` traps the `TypeError`.
- **The library's semantics absorb the difference.** `String(["a","b"])` is `"a,b"`, same as `join(",")`. `isEmpty(undefined)` is already `true`. An `includes` over strings never matches `null`.
- **The consumer treats both results the same.** A `default` that falls through and returns `undefined` where the caller uses it as falsy. An empty `catch` in a class-validator validator, which treats `undefined` as invalid.
- **Identities.** `[].every(...)` is `true`: a preceding `length === 0 → return true` is redundant.
- **The ORM already does it.** `distinct` over entities TypeORM deduplicates by primary key, the `deleted_at IS NULL` that soft-delete adds.

**When the reason depends on a library's behavior, check it, don't recall it:** `node -e 'console.log(require("lodash").isEmpty(5))'` takes a second. In the same corpus, `isEmpty(5)` turned out `true`, which nobody would have said from memory.

### Probing

When reading does not decide, apply the mutant and run something:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/probe.mjs <out-dir>/mutation.json <back-dir> <id> -- <command>
```

Applies mutant `<id>`, runs the command and restores the file. The first word of the output is the verdict:

| Verdict | Exit | Meaning |
|---|---|---|
| `SURVIVED` | 0 | the command passes with the mutant |
| `KILLED` | 0 | the command fails with the mutant **and passes without it** (the probe reruns it unmutated to confirm) |
| `ERROR` | 3 | the command could not run, or **it also fails without the mutant**: a database that is down, a red test. Says nothing about the mutant |
| `TIMEOUT` | 4 | the command did not finish within `PROBE_TIMEOUT_MS` (default 10 min). Says nothing about the mutant |

Exit 1 means the file could not be restored: stop and restore it with `git checkout`.

`ERROR` and `TIMEOUT` are never a verdict on the survivor. Fix the cause (for example, start the database) and probe again, or leave the survivor `unclear` with the reason.

- **Before declaring a `gap` in a file that has integration tests**, unless the integration stage already ran it (`integration.status: "Survived"` without `SELECTOR_INCOMPLETE`), probe with the integration test, through the script the repo uses to run one integration file (read `package.json`), e.g. `-- npm run test:integration -- <path/to/file.test.ts>`. It needs whatever the integration suite needs locally, usually a database. In the measured reference, one of the two permission-check candidates died here.
- **To confirm a `gap`**, the strongest move is writing the test with the distinguishing input in a temporary file and probing with it: if it fails with the mutant and passes without it, the gap is proven. Delete the file afterwards.

### The central warning

**Killed does not mean correct.** A test can pin a bug: in one measured service, mutating an authorization check from `&&` to `||` — that is, fixing the bug — came out KILLED, because a test asserted the buggy behavior. Faced with a survivor, the question is not "how do I kill it?" but **"what is the correct behavior here?"**. If the answer is the mutant, the verdict is `bug`.

### No coverage and suspicious kills

- **`noCoverage`** comes grouped by file. No unit test executes those lines. If the file has integration tests, it is not a gap: it is code that lives in integration. One line per file, not per mutant.
- **`suspiciousKills`** are mutants that died from a hook timeout, a dropped connection or a segfault, not from an assertion. If there are any, the score is inflated and those mutants may hide gaps. Say so.

## Output

What needs doing first, then what was discarded, one line each so it can be audited:

```markdown
**<n> gaps, <n> bugs, <n> unclear** out of <survivors> survivors · score <scoreOverCovered>% · <mutants> mutants in <files> files

### Gaps
1. `file.ts:LL` — <what is not tested>. Input: <the distinguishing input>. Belongs in `<file.test.ts>`.

### Bugs
1. `file.ts:LL` — <the case where the original fails, and what the mutant does>.

### Unclear
1. `file.ts:LL` — <what is missing to decide>.

### Discarded
- `file.ts:LL` · equivalent · <the reason in one sentence>
- `file.ts:LL` · killed-by-integration · `<test>`
```

If there are no gaps, say so on the first line.

## Limits

- **Without `--integration`, unit tests only.** A service whose logic is tested through integration comes out almost entirely `noCoverage`; `--integration` is the way to measure it.
- **Equivalent mutants cannot be marked.** Stryker has no way to remember them: they come back on the next run. That is why triage explains them in one line, so the second time is reading, not thinking.
- **Mutation does not see a badly designed algorithm.** It perturbs the code that was written; it does not propose the code that was missing. 27% of real faults couple with no mutant (Just et al., 2014).
