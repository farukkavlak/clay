# Tech debt

What has to be fixed before any new feature. Found in the audit of 2026-09-17.

## Where things stand (2026-09-17)

The tests pass (261), and so do the type check and the build. Lint shows 25 warnings, and
`npm audit` reports 20 vulnerabilities.

The unit tests mock the provider and the state, so they missed that the real
apply → plan cycle is broken. Running the CLI against real files shows it.

## How we work

- One section at a time, in order.
- A bug fix starts with a test that fails.
- Small changes go straight to `main`; larger ones get a branch and a PR.
- No new features until this file is done.

## 0 — formatting

Done first, in a commit of its own, so later diffs show only real changes.

- [ ] Prettier runs with its defaults. The import-sorting and package.json plugins are gone.
- [ ] The whole repo is reformatted in one `style:` commit, and that commit is listed in
      `.git-blame-ignore-revs`.

## 1 — bugs

- [ ] A plan right after an apply wants to replace everything. The planner compares
      resolved values in state with raw AST values from the config, so they never match.
- [ ] Replacing a resource drops it from state. Creates run before deletes, and the delete
      removes the entry the create just wrote.
- [ ] `init` overwrites an existing state file.
- [ ] `apply <plan-file>` makes a new plan instead of running the saved one, and only warns
      when the config has changed.
- [ ] An attribute removed from the config stays in state.
- [ ] `apply` never takes the state lock.
- [ ] The planner matches replacements by type and name only, ignoring the module path.
- [ ] The plan output says "destroyd".
- [ ] End-to-end tests with the real CLI in a temp directory, one for each bug above.

## 2 — dependencies

- [ ] Each package lists the `@miniform/*` packages it imports. Most only work because npm
      hoists them.
- [ ] Shared dev tools (typescript, vitest, eslint, esbuild, `@types/node`) are listed only
      in the root. Three packages still ask for vitest 0.34 and eslint 8.
- [ ] Unused dev dependencies removed: the react, react-hooks and i18next ESLint plugins,
      and `ts-node`.
- [ ] `npm audit` is clean.
- [ ] Every package points `main` at `dist`, not at `src`.
- [ ] The CLI uses Node built-ins instead of chalk (`util.styleText`), commander
      (`util.parseArgs`) and inquirer (`readline/promises`).
- [ ] `engines.node` is `>=22`, which `util.styleText` needs.

## 3 — code

- [ ] Lint has no warnings, and warnings count as errors.
- [ ] The orchestrator's parts get their collaborators passed in, not `bind`-ed callbacks.
- [ ] The CLI commands share their helpers instead of copying them.
- [ ] `apply` parses the config and reads data sources once, not twice.
- [ ] The ESLint config fits this repo. The current one came from a React project.

## 4 — repo

- [ ] `npm run miniform` works; it points at a file that doesn't exist.
- [ ] The README describes what exists now, in short, plain English.
- [ ] Tests write only to temp directories; the committed `miniform.state.json.bak` is gone.
- [ ] Merged and empty branches are deleted (19).
- [ ] CI runs lint, format check, type check, build and tests on every push and PR.
- [ ] husky and lint-staged run on commit.
- [ ] `.editorconfig`, a license file and a changelog are added.
- [ ] `TASKS.md` matches what is actually done.
