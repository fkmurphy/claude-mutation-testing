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

- `<back-dir>`: the service directory, the one with `package.json` and `jest.config.js`. Ideally inside a throwaway worktree.
- `<out-dir>`: outside the repo, e.g. the session scratchpad.
- `<file>`: paths relative to `<back-dir>`. Code, never tests. Accepts a range to narrow it to what changed: `src/lib/orders/Order.ts:120-180`. In a review, the diff's range.
- `--typecheck`: discards mutants TypeScript would reject. Slower.

Prints `summary.json` to stdout and leaves it in `<out-dir>`, next to `mutation.json` (the full report, used for probing) and the logs.

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | ran | triage |
| 2 | bad usage | fix the arguments |
| 3 | **red baseline** | stop. With tests failing unmutated, every mutant counts as killed and the result is noise. Report which tests fail |
| 4 | Stryker failed | read the tail of `stryker.log` it prints |
| 5 | could not install | read `install.log` |

It takes about **2.5 s per mutant** at the default concurrency (4), plus `pnpm install` if the worktree is new. A typical file has 20 to 100 mutants. For many files, say so before running.

## Already filtered out

No need to discard these again:

- **Logs.** Calls to `logger.*`, `baseLogger.*`, `getLogger().*` and `.child(...)`, and the statement that contains them. Instrumentation is not business logic.
- **Static code.** Code that only runs when the module loads (`ignoreStatic`). A chosen blind spot: module-level config is not measured.
- **Integration.** Nothing is mutated against integration (the script excludes the same test paths the repo's `test-unit` script excludes, or `src/test/integration/` if it has none); each mutant would cost seconds of database. It is used to settle survivors, below.
- **Timeouts under load.** Stryker counts a timeout as detected, and with several runners in parallel a slow test runs out of time without the mutant having broken it: at concurrency 6, 58 of 67 mutants "died" that way and only 2 of 13 survivors were left. The script reruns each timeout alone, with no load, and the one that passes goes back to the list with `revivedFromTimeout: true`. `Hit limit reached` ones are real infinite loops and stay as detected.

## Triage each survivor

For each one, read the whole function and the tests in `coveredBy`. Survivors on the same line or function are analyzed together: they usually share a cause.

There is one question: **is there a realistic input, allowed by the contract, that tells the original apart from the mutant?**

| Verdict | When | What it carries |
|---|---|---|
| `gap` | An input tells them apart, and no test uses it | **the concrete input** and the test where it belongs |
| `bug` | The mutant behaves better than the original | the case where the original fails |
| `equivalent` | No allowed input tells them apart | **why**: which layer or which semantics absorbs it |
| `killed-by-integration` | An integration test kills it (probed) | the test that kills it |
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

Applies mutant `<id>`, runs the command and restores the file. Prints `KILLED` or `SURVIVED`.

- **Before declaring a `gap` in a file that has integration tests**, probe with the integration test: `-- pnpm run test src/test/integration/<file>.test.ts`. It needs whatever the integration suite needs locally, usually a database. In the measured reference, one of the two permission-check candidates died here.
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

- **Unit tests only.** A service whose logic is tested through integration comes out almost entirely `noCoverage`.
- **Equivalent mutants cannot be marked.** Stryker has no way to remember them: they come back on the next run. That is why triage explains them in one line, so the second time is reading, not thinking.
- **Mutation does not see a badly designed algorithm.** It perturbs the code that was written; it does not propose the code that was missing. 27% of real faults couple with no mutant (Just et al., 2014).
