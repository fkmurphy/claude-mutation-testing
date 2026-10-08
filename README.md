# claude-mutation-testing

Claude Code plugin that checks whether the tests of a Node/TypeScript service actually protect
the code. It runs Stryker on specific files or line ranges and triages the survivors until only
real gaps are left.

- **Skill `mutation-testing`** — `scripts/mutate.sh` does the mechanical part in one call
  (installs Stryker only when missing, runs the related-tests baseline, runs Stryker, rechecks
  timeouts with no load, reduces the report); `scripts/probe.mjs` applies a single mutant and
  runs a command against it.
- **Agent `mutant-triager`** — preloads the skill, runs the script first and triages every
  survivor into `gap`, `bug`, `equivalent`, `killed-by-integration`, `noise` or `unclear`.

- **`scripts/affected-tests.mjs` (experimental, not used by the agent yet)** — finds the tests
  that reach the given lines without running anything: walks references upward with the
  project's own TypeScript language service, follows Express routes (hand-written routers and
  generated ones such as tsoa's) to the tests that call their URL, and reports where the static
  walk stops (queue workers, shared base methods).

  ```bash
  node skills/mutation-testing/scripts/affected-tests.mjs <back-dir> <file>[:<from>-<to>] [...]
  ```

## Install

```
/plugin marketplace add fkmurphy/claude-mutation-testing
/plugin install mutation@claude-mutation-testing
```

Then ask for it in plain words ("check whether the tests of `src/lib/orders/Order.ts` protect
anything") or call the agent `mutation:mutant-triager` with the service directory and the files.

Requires Node, Jest, one of pnpm, yarn or npm, and `git` for throwaway worktrees (recommended).

## Configuration

Nothing is required: with no config file the defaults below apply, and what can be detected from
the repo is detected. To change something, add an optional `.mutation.json` in the service
directory (`<back-dir>`); each key you set overrides only that value.

```json
{
  "ignoreCalls": ["audit.*"],
  "unitTestIgnorePatterns": ["/src/test/integration/"],
  "setupFilesAfterEnv": ["<rootDir>/src/test/globalSetup.ts"],
  "excludedMutations": [],
  "concurrency": 4
}
```

| Key | Default without the file |
|---|---|
| `ignoreCalls` | the log levels (`info`, `warn`, `error`, `debug`, `trace`, `fatal`, `child`) on `*logger`, `this.*logger`, `*logger.child()` and `getLogger()`, plus `console.*`: calls that are not mutated. Yours are **added** to these; set `replaceDefaultIgnoreCalls: true` to use only yours. `*` stands for one name and never crosses a dot or a call; `{a,b}` is one of the listed names, e.g. `audit.{info,warn}` |
| `packageManager` | detected from the lockfile (`pnpm-lock.yaml`, `yarn.lock` or `package-lock.json`) in `<back-dir>` or above it up to the repo root, then from the `packageManager` field of `package.json`; without either, `npm` |
| Jest config | `jest.config.js`, `jest.config.cjs` or the `jest` key of `package.json` |
| `unitTestIgnorePatterns` | the `--testPathIgnorePatterns` of the repo's `test-unit` script; without it, `/src/test/integration/` |
| `setupFilesAfterEnv` | `src/test/globalSetup.ts` if it exists. Added to the `setupFilesAfterEnv` of the jest config |
| `excludedMutations` | none: every mutator runs |
| `concurrency`, `maxTestRunnerReuse` | 4 and 20; also `MUTATE_CONCURRENCY` and `MUTATE_REUSE` |

The run prints the effective value of each setting and where it came from, and `summary.json`
carries it under `config`.

Only Jest is supported as a test runner, with a CommonJS config that exports an object: `jest.config.ts`, `.mjs` and a config that exports a function are not supported yet. Yarn means yarn classic (1.x): Berry with Plug'n'Play has no `node_modules` to run from. The scripts run the repo's install and its tests, and
`probe.mjs` edits files in place: use it on code you trust.

See `CHANGELOG.md` for what changed and why.

## License

MIT, see `LICENSE`.
