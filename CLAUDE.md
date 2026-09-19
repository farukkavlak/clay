# Miniform

A small infrastructure-as-code engine in TypeScript, built to show how Terraform works
inside. It is a portfolio project, so clean code and clean history matter as much as
features.

## Now

No new features. Work through `docs/TECH_DEBT.md` in order, and tick an item in the same
change that fixes it. `docs/TASKS.md` is the feature list, and it waits.

## How we work

The owner makes the decisions and has to understand every line that lands.

- Before writing code, explain the problem, the options and your pick, then wait.
- Keep each change small enough to review in one sitting.
- After a change, explain what changed and why.
- Nothing lands that the owner hasn't seen and understood.

## Packages

| Package          | Does                                                           |
| ---------------- | -------------------------------------------------------------- |
| `parser`         | Turns `.mini` files into an AST (`docs/GRAMMAR.md`)            |
| `graph`          | Dependency graph, sorted into layers that can run in parallel  |
| `contracts`      | Interfaces shared by the engine and providers                  |
| `state`          | Reads and writes state, with a lock and a backup               |
| `planner`        | Compares config with state and lists the actions               |
| `orchestrator`   | Loads modules, resolves references and runs the plan           |
| `cli`            | The `miniform` command                                         |
| `provider-local` | `local_file`, `random_string`, `null_resource`, `command_exec` |

## Commands

```sh
npm ci
npm run build
npm test
npm run lint
npm run type:check
npm run format
```

Try the CLI in a temp directory, never in the repo: `node packages/cli/bin/miniform.js plan`.

## Commits

- Never commit, push or open a PR. Suggest the command and the owner runs it.
- Format: `type: what changed`, lowercase, no period, under 72 characters. Types: `feat`,
  `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Say what the change does, in plain words: `fix: keep a replaced resource in state`.
- Small changes go straight to `main`. Larger ones get a branch (`fix/replace-state`) and
  a PR, squash-merged. The PR title is the whole commit message and says the change in
  one sentence; the PR description stays empty.
- One change per commit. Don't mix a fix with a refactor.
- Build, tests, type check and lint pass before a commit.
- Before giving the PR commands, run the `pr-reviewer` agent on the branch, fix what it
  finds, and tell the owner what it found.

## Dependencies

- A package lists every `@miniform/*` package it imports.
- Shared dev tools live in the root `package.json` only.
- If Node or a few lines of our own can do it, don't add a package. Ask before adding
  a runtime dependency.
- Remove a dependency in the same change that stops using it.
- Commit the lockfile with any dependency change.

## Code

- Strict TypeScript, no `any`. No `eslint-disable` or `@ts-ignore` without a reason.
- Small functions; the complexity limit is 10.
- Pass collaborators in through the constructor.
- AST values (`{ type, value }`) and resolved values are different things. Don't compare
  one with the other.
- Comments only where the code can't say why. One short line; no comment that restates the
  code.
- Code and comments never point to docs, issues or plans (`see TECH_DEBT.md`, `TODO(PR 2)`).

## Tests

- A bug fix starts with a failing test.
- Anything that crosses packages also gets an end-to-end test with real files in a temp
  directory. Mocks hid the bugs in `TECH_DEBT.md`.
- Tests never write into the repo.
- Nothing lives in `src` only because a test needs it. A helper a test needs sits next to
  the tests.

## Docs

- Short, plain English that a reader can skim. Short sentences, concrete facts.
- No filler, no marketing words, no emoji, no restating what the heading says.
