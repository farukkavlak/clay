# Tech debt

What has to be fixed before any new feature. Audited on 2026-09-17, rechecked on
2026-09-19.

## Where things stand

281 tests pass, and so do the type check and the build. Lint shows 23 warnings, and
`npm audit` reports 20 vulnerabilities (2 critical, 11 high).

The unit tests mock the provider and the state, so they missed that the real
apply → plan cycle is broken. Running the engine against real files shows it.

## How we work

- One section at a time, in order.
- A bug fix starts with a test that fails.
- Small changes go straight to `main`; larger ones get a branch and a PR.
- No new features until this file is done.

## 0 — formatting

- [x] Prettier keeps the old style (single quotes, 180 columns, es5 trailing commas)
      without its plugins, so no file had to be reformatted.

## 1 — bugs

In order: the safety net first, then the engine, then the CLI, then the output.

- [x] End-to-end tests that run the engine with the real provider and a real state file in
      a temp directory. Each fix below brings its own.
- [x] A plan right after an apply wants to replace everything, for every value the plan can
      resolve. The planner compared resolved values in state with raw AST values from the
      config, so they never matched. It broke when the orchestrator started writing
      resolved values to state and nothing told the planner; a `Record<string, any>` on
      `IResource.attributes` and a cast in the planner kept the compiler quiet, and the
      planner's tests built their own state in the old shape.
- [x] A resource that reads a value from a resource changing in the same run was planned
      against the old state, so it came out `NO_OP` and kept its old content until the next
      apply. The plan now walks the dependency graph: a reference whose target has a
      pending action is unknown, a reference to a resource no config declares is an error,
      and a cycle names the resources in it.
- [ ] A reference into another module (`module.app.local_file.a.content`) is read as a
      module output, so it fails as undeclared. The resolver understands the form, the
      graph does not.
- [ ] `plan` never computes module outputs, so every `${module.x.y}` is unknown and its
      resource shows a change that never settles.
- [ ] Replacing a resource destroys it. Creates run before deletes, so the delete removes
      the file the create just wrote, and drops it from state.
- [ ] An attribute removed from the config stays in state. `executeUpdate` spreads the old
      attributes under the new ones, so a key the config dropped survives.
- [ ] A failed action loses the whole run. `apply` writes state only after the last
      action, so resources already created are left untracked.
- [ ] `apply` never takes the state lock, so two runs can write the same file.
- [ ] `init` overwrites an existing state file.
- [ ] `apply <plan-file>` makes a new plan instead of running the saved one, and only
      warns when the config has changed.
- [ ] `state` and `output` read a state file nothing writes. Both default to
      `.miniform/state.json`, the engine writes `miniform.state.json`, and `state` passes
      that path to `LocalBackend` as a directory.
- [ ] The config file has two names: the CLI reads `main.mini`, modules are loaded from
      `main.mf`, and `validate` defaults to `main.mf`.
- [ ] Relative paths in `local_file` resolve against the current directory, not the
      config's directory.
- [ ] `local_file` rejects empty content. `validate` tests the value for truthiness
      instead of its type.
- [ ] The planner matches replacements by type and name only, ignoring the module path.
- [ ] `plan` never says "No changes". It checks for an empty list, but the planner returns
      a `NO_OP` action for every unchanged resource.
- [ ] A replacement prints as one add and one destroy, not as one replace.
- [ ] The plan output says "destroyd" and "no-opd".

## 2 — dependencies

- [ ] Each package lists the `@miniform/*` packages it imports. Only the CLI lists any,
      and it misses `graph`, `parser` and `planner`.
- [ ] Shared dev tools (typescript, vitest, eslint, esbuild, `@types/node`) are listed
      only in the root. Three packages still ask for vitest 0.34 and eslint 8.
- [ ] Unused dev dependencies removed: the react, react-hooks and i18next ESLint plugins,
      and `ts-node`.
- [ ] `npm audit` is clean.
- [ ] `orchestrator` and `planner` point `main` at `dist`, not at `src`.
- [ ] The CLI uses Node built-ins instead of chalk (`util.styleText`), commander
      (`util.parseArgs`) and inquirer (`readline/promises`).
- [ ] `engines.node` is `>=22`, which `util.styleText` needs.
- [ ] `IState` moves to `contracts`, next to `IResource`. `planner` and `orchestrator`
      depend on `@miniform/state` only for that type, and the shape state is written in is
      a contract every side has to agree on. Keeping it inside one side is how the planner
      drifted away from it.

## 3 — code

- [ ] Lint has no warnings, and warnings count as errors.
- [ ] The ESLint config fits this repo. The current one came from a React project.
- [ ] The orchestrator's parts get their collaborators passed in, not `bind`-ed callbacks.
- [ ] `apply` parses the config, reads data sources and builds the dependency graph once,
      not twice. It calls `plan`, which now does all three, and then does them again.
- [ ] `apply` and `plan` yield events (resource started, created, failed, done) and the CLI
      only renders them. Do this with the failed-action bug above: writing state as the
      events arrive is the fix, progress becomes visible, and the CLI tests stop spying on
      `console.log`.
- [ ] Resolving works on a context that can be cloned per scope, instead of one mutable
      `ScopeManager` keyed by scope strings. The dependency-order fix needs to resolve the
      same config against different sets of pending values.
- [ ] The CLI commands share their helpers instead of copying them.
- [ ] Comments that only restate the code are gone (`// Mock Provider for testing`).

## 4 — repo

- [ ] `npm run miniform` works; it points at a file that doesn't exist.
- [ ] Tests write only to temp directories; the committed
      `packages/orchestrator/miniform.state.json.bak` is gone.
- [ ] CI runs lint, format check, type check, build and tests on every push and PR.
- [ ] husky and lint-staged run on commit.
- [ ] The README describes what exists now, in short, plain English. It still shows
      `resource "file"`, which no provider has.
- [ ] `TASKS.md` matches what is actually done.
- [ ] Merged and empty branches are deleted (19).
- [ ] `.editorconfig`, a license file and a changelog are added.
