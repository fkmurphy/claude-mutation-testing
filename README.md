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

## Assumptions

- A service directory with `package.json`, `jest.config.js` and pnpm.
- Unit tests are what the repo's `test-unit` script runs: its `--testPathIgnorePatterns` are
  read from `package.json`. Without that script, integration tests are assumed to live in
  `src/test/integration/`.
- Logging through `logger.*`, `baseLogger.*` or `getLogger()`; those calls are not mutated.

See `CHANGELOG.md` for what changed and why.
