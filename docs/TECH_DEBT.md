# Tech debt

What has to be fixed before any new feature. Audited on 2026-09-17, rechecked on
2026-09-19 and 2026-09-20.

## Where things stand

365 tests pass, and so do the type check and the build. Lint shows 11 warnings, and
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
- [x] A module input that reads a resource (`module "m" { text = "${local_file.a.content}" }`)
      was not scanned for dependencies, so the first apply failed with the resource missing
      from state. Variables are graph nodes now, the way Terraform has them: what a
      variable reads runs before it, and it runs before whoever reads it. A variable fed by
      a pending resource is unknown, and one that is used but never defined is named.
- [x] A variable default that reads a resource (`variable "v" { default = "${local_file.a.id}" }`)
      was written out literally. `processVariables` stored the unwrapped string, so the
      resolver never interpolated it. Every variable now holds its AST value and the state
      gets the resolved one.
- [x] A reference into a module (`module.app.local_file.a.content`) was read as an output
      named `local_file` and failed as undeclared. Reaching inside a module stays
      unsupported, the way Terraform has it, and the message now says that modules are
      read through their outputs.
- [x] `plan` never computed module outputs, so every `${module.x.y}` was unknown and its
      resource showed a change that never settled. Outputs are now given their value on the
      same walk as the resources, and an output fed by a pending resource is unknown.
- [x] Replacing a resource dropped it from state. The planner emitted a DELETE and a CREATE,
      creates ran before deletes, and the delete removed the entry the create had just
      written, so the next plan created it again. A replacement is one `REPLACE` action
      now: delete, create, one state entry.
- [x] An attribute removed from the config stayed in state. `executeUpdate` spread the old
      attributes under the new ones, so a key the config dropped survived and every plan
      wanted to drop it again. State holds what was last applied, nothing older.
- [x] A failed action lost the whole run. `apply` wrote state only after the last action,
      so resources already created were left untracked. The state file is rewritten after
      every action now, and a failed run stops with everything before it on disk.
- [x] `apply` never took the state lock, so two runs could write the same file. A run holds
      the lock from start to finish and lets go however it ends. `plan` only reads, so it
      does not lock.
- [x] Resources removed from the config were deleted in state order, not in reverse
      dependency order, so a dependency could go before what still read it. The config no
      longer knows a removed resource, so every resource now writes down what it reads
      from, the way Terraform does, and deletes follow that list backwards. The list is
      written on every action, an unchanged one included, so it never goes stale.
- [x] `init` overwrote an existing state file, so running it in a workspace that already
      had resources left them untracked. It now writes a state only when there is none and
      says which of the two it did. Terraform's `init` is safe to run again, and this one
      is too.
- [x] `apply <plan-file>` made a new plan instead of running the saved one, and only warned
      when the config had changed, so what ran could differ from what was approved. A plan
      file now carries the configuration it was made from, the way Terraform's does, and
      `apply` runs the saved actions against it without reading `main.clay` again and
      without asking again. A plan naming a resource that configuration does not declare
      stops the run. A plan file from another version of Clay is refused.
- [x] A saved plan carried the root configuration but its modules were still read from
      disk, so a module file edited after the plan changed what ran. The loader reads
      modules through a `ConfigFiles` collaborator now: the disk when planning, with every
      file it read remembered and written into the plan; the plan's own copy when applying
      one. The engine no longer takes a root directory; where files come from is decided
      where it is built. The orchestrator tests stopped mocking `node:fs` for the same
      reason.
- [x] A saved plan was run against whatever the state held at the time. If another run
      changed the state in between, the plan was stale: a resource it planned to create
      could already exist. The state now carries a `serial` that every write increments,
      as in Terraform. A plan records the serial it was made from, and applying it stops
      when the state has moved on.
- [x] `state` and `output` read a state file nothing writes. Both defaulted to
      `.clay/state.json` while the engine writes `clay.state.json`, and both handed
      that whole path to `LocalBackend`, which takes a directory and a file name, so even
      `--state` read the wrong place. One helper now builds the backend for both: the
      default is the engine's own, and a path on the command line is split into the two
      parts the backend wants.
- [x] `state show` printed the resource type as `Resource`. State keeps the AST node type in
      `type` and the real type in `resourceType`, and the command read the first one. The
      mocked test had put the real type in `type`, which is how it passed.
- [x] `output` printed the variables saved in state as if they were outputs, and state held
      variables in the first place, so `apply` and `output` answered the same question
      differently. State holds the root module's outputs now, the way Terraform does, and
      nothing else: variables are inputs that come with each run. `output` reads those, and
      state is written in full, so what an older version left behind goes.
- [x] Outputs in state were only written at the end of an apply that got there, so they
      went stale. A config that changed nothing but an `output` block planned no actions,
      and the CLI stopped at "No changes needed" without running; a run that failed partway
      left the previous run's outputs next to the new resources; `state rm` and `state mv`
      did not touch outputs at all, so one could name a resource that was gone. Outputs in
      state are now what the last finished run left: the plan lists output changes, as
      Terraform does, and an output change alone is reason to run; a run drops the outputs
      before its first write and puts them back with its last; `state rm` and `state mv`
      drop them too, and the next run writes them again. Terraform leaves them after
      `state rm`; a stale value shown as current is a wrong value, so Clay does not.
- [x] The config file had two names: the CLI read `main.mini`, modules were loaded from
      `main.mf`, and `validate` defaulted to `main.mf`, so a module had to be written under
      a different name than the config that called it. One name now: `main.clay`.
- [x] Relative paths in `local_file` resolve against the directory `clay` runs in, not the
      directory of the config that names them. Kept, on purpose: a provider gets plain
      values and knows nothing about where the config lives, and Terraform's `local_file`
      resolves the same way. A module that wants a file next to itself needs `path.module`,
      which is on the feature list. A test now pins the rule.
- [x] `local_file` rejected empty content: `validate` tested the value for truthiness
      instead of its type, and `""` is falsy. It checks the type now, so an empty file is
      a file.
- [x] The planner matched replacements by type and name only, ignoring the module path. The
      check existed to keep a replacement's DELETE apart from a removal's; with one
      `REPLACE` action there is nothing to tell apart.
- [x] `plan` never said "No changes". It checked for an empty list, but the planner returns
      a `NO_OP` action for every unchanged resource, so the list is never empty. It looks
      for actions that do something now. A plan with none is still saved when `--out` asks.
- [x] A replacement printed as one add and one destroy, not as one replace. It is one
      `-+ ... will be replaced` line now; the summary still counts it as an add and a
      destroy, the way Terraform sums it.
- [x] The plan output said "destroyd" and "no-opd": the verb had a `d` glued on. It says
      "destroyed" now, and a NO_OP is never printed.

Found by the 2026-09-20 audit, each one reproduced with the built CLI:

- [x] `plan` did not validate. It never called the provider's `validate`, and a resource
      type no provider handled planned as "1 to add". `length = "8"` on a `random_string`
      and `resource "aws_bucket"` both passed `plan` and failed in `apply`. Now `plan`
      stops on both, as Terraform does, and names the resource in the message. A resource
      with a value that is not known yet is skipped and checked in the run, once the value
      is.
- [x] A variable with no value turned into an empty string. `variable "name" {}` read as
      `"hello ${var.name}!"` gave `hello !`; the `?? ''` in `interpolateString` swallowed
      it. Now a variable with no default and no input stops the load, read or not, the way
      Terraform treats a variable as the module's input contract, and the error names the
      module when it is one.
- [x] `validate` rejected valid configuration. It handed the raw AST value to the
      provider, so `content = local_file.a.content` failed with "requires content
      (string)". It also knew nothing of modules, variables and outputs, and had a
      dependency check of its own instead of the engine's graph. Now it asks the engine to
      check the config the way `plan` does, against an empty state, so what a resource
      would give is unknown and everything else is checked; `validate.ts` went from 142
      lines to 40. It reads `main.clay` in the current directory like `plan` and `apply`,
      instead of a path of its own. Its mocked unit tests, which tested the copy, are
      replaced by end-to-end ones. Data sources are still read while the config loads
      (`TASKS.md` 10.9).
- [x] `state mv` moved the key and left the entry behind: `name` and `modulePath` inside
      it still said the old address, and other resources' `dependencies` still named it.
      A later delete was planned from the entry's own name, so it deleted an address that
      was not there and the moved resource stayed in state for good. Now the entry and
      every `dependencies` list take the new address, and a move that changes the type is
      refused, as in Terraform. `Address` is exported from the orchestrator for the parse.
- [x] A file removed by hand could not be destroyed. `local_file.delete` failed on
      `ENOENT` and the run failed the same way every time; only `state rm` got out. The
      provider now treats a file that is already gone as deleted, the way Terraform's
      providers treat "not found". A file removed by hand that stays in the config is
      still not noticed; that is refresh (`TASKS.md` 10.2).
- [x] Two blocks with one name were not caught. Two `module "m"` blocks passed in silence
      and the second one won; two `resource "null_resource" "a"` blocks failed with
      `Node null_resource.a already exists`, a message from the graph, not from the config.
      The parser now refuses the second block of a kind with a name already used, with its
      line and column, the way Terraform refuses a duplicate declaration.
- [x] An attribute could not be called `data`, `module`, `variable`, `output` or
      `resource`: the lexer took the keyword before the identifier, so `data = "x"` was a
      parse error. There are no keywords now, as in HCL and as `GRAMMAR.md` already said:
      a block kind is an identifier the parser recognises at the start of a statement,
      and the five keyword tokens are gone with the list of tokens a reference may hold.
- [ ] A string that is one interpolation loses its value's type: `"${var.list}"` becomes
      `[object Object]` and `"${var.n}"` becomes `"8"`. Terraform gives the value itself
      when the whole string is one interpolation.
- [ ] The CLI prints a resource without its module: `plan`, `apply` and the applied lines
      all say `local_file.f` for `module.m.local_file.f`, so two modules with the same
      resource name are told apart by nothing. `Address.of(action).toString()` has the
      full name. While there: the apply summary says `Resources: 1 changed` for a create;
      Terraform counts added, changed and destroyed apart.
- [ ] The state file is written in place. A run killed halfway through `writeFile` leaves
      a torn file and the `.bak` is not restored. Writing to a temp file and renaming it
      makes the write atomic.

## 2 — dependencies

- [ ] Each package lists the `@clay/*` packages it imports. Only the CLI lists any, and it
      misses `graph`.
- [ ] Shared dev tools (typescript, vitest, eslint, esbuild, `@types/node`) are listed
      only in the root. Three packages still ask for vitest 0.34 and eslint 8.
- [ ] Unused dev dependencies removed: the react, react-hooks and i18next ESLint plugins,
      and `ts-node`.
- [ ] `npm audit` is clean.
- [ ] `orchestrator` and `planner` point `main` at `dist`, not at `src`.
- [ ] The CLI uses Node built-ins instead of chalk (`util.styleText`), commander
      (`util.parseArgs`) and inquirer (`readline/promises`).
- [ ] `engines.node` is `>=22`, which `util.styleText` needs.
- [ ] A package's build does not bundle the `@clay/*` packages it imports. Every `dist` is
      an esbuild bundle, so the CLI carries its own copy of the parser, the planner and the
      rest, and so does the orchestrator. Workspace packages stay external. It also makes
      one `npm run build` unreliable: the CLI is built before the parser in workspace
      order, so its bundle carries the parser's previous `dist`.
- [ ] `tsconfig.json` fits this repo: `experimentalDecorators` and the `cdk.out` exclude
      came from another project; esbuild targets `node18` while `engines` will say 22;
      `vitest` is 0.34 in some packages and 4 in others, `eslint` 8 and 9. `lib` is
      `es2021`, so `new Error(message, { cause })` does not compile; once it is `es2022`,
      the plan's provider errors keep the provider's error as their cause.
- [ ] `IState` moves to `contracts`, next to `IResource`, with an `emptyState()` beside it:
      `{ version: 1, serial: 0, resources: {} }` is spelled out in `init`, `LocalBackend`
      and `Orchestrator.validate`. `planner` and `orchestrator` depend on `@clay/state`
      only for that type, and the shape state is written in is a contract every side has
      to agree on. Keeping it inside one side is how the planner drifted away from it.

## 3 — code

- [ ] Lint has no warnings, and warnings count as errors.
- [ ] The ESLint config fits this repo. The current one came from a React project.
- [ ] The orchestrator's parts get their collaborators passed in, not `bind`-ed callbacks.
      One factory builds the object graph and hands it over. No DI container: at this size
      it buys nothing the factory does not, and it would hide the wiring behind a runtime
      dependency. The plan walk (graph order, the pending set, resolve-or-unknown) moves
      into a part of its own; `Orchestrator` grew from 228 to 346 lines through the planner
      fixes.
- [ ] `apply` parses the config, reads data sources and builds the dependency graph once,
      not twice. It calls `plan`, which now does all three, and then does them again.
- [x] `apply` yields events (planned, started, applied, failed, done) and the CLI only
      renders them. Writing state as each `applied` arrives was the failed-action fix; the
      CLI now prints a line per resource. `plan` stays a plain call: it computes a list and
      has nothing to report along the way. Resources in one layer run one after another
      now, not in parallel.
- [ ] Resolving works on a context that can be cloned per scope, instead of one mutable
      `ScopeManager` keyed by scope strings. The dependency-order fix needs to resolve the
      same config against different sets of pending values.
- [ ] The CLI commands share their helpers instead of copying them. `apply` has its own
      copy of the action list and it says less than `plan`'s: no "will be replaced", no
      diff.
- [ ] Comments that only restate the code are gone (`// Mock Provider for testing`).
- [ ] The parser reads a block's attributes in one place, not four (resource, data,
      variable and module carry the same loop). `LocalProvider` looks its handler up in
      one place, not six. `ModuleOutputResolver` builds a child scope by hand next to
      `childScope`, and the data-source key is spelled out in `processDataSources` and
      again in `DataSourceResolver`.
- [ ] Dead code is gone: `ReferenceScanner` handles an `Interpolation` node the AST does
      not have; `parser.parse() || []` guards a value that is never falsy;
      `ResourceResolver.getResolvedAttribute` unwraps a `{ type, value }` from state, which
      must never hold one; `ResourceResolver` resolves `module.x.res.attr`, which
      `ReferenceScanner` refuses; `Address.withParent` and `Address.equals` are only
      called by tests.
- [ ] The CLI is consistent with itself: `--state` is on `state` and `output` but not on
      `plan` and `apply`; the version is typed into `index.ts` instead of read from
      `package.json`; `init` creates a `.clay/` directory nothing uses; `plan` prints
      "Refreshing state..." and refreshes nothing; `state list` says "The state file is
      empty" when there is no file and `output` says where it looked.
- [ ] A parse error in a module names its line and column but not its file, so
      `[Line 2, Column 1] ...` from `plan` does not say which `main.clay`. The module
      loader knows the path and can put it in front.
- [ ] The lexer slices the rest of the input on every token, so a file lexes in quadratic
      time. A sticky regex reads in place.
- [ ] The `I` prefix on type names is gone: `IResource`, `IProvider`, `IResourceHandler`,
      `ISchemaDefinition`, `ISchema`, `IState`, `IStateBackend` and `IResolver` carry it
      and the other seventeen types do not. TypeScript does not need the prefix, and half
      the names that would earn it by any rule (`PlanAction`, `RunEvent`) go without. While
      there: `IResource.type` is always `Resource`, an AST label copied into state that
      nothing reads; it goes.

## 4 — repo

- [ ] `npm run clay` works; it points at a file that doesn't exist.
- [ ] Test fixtures match the state shape: five mocked states still carry a `variables`
      key that state no longer has.
- [ ] Tests write only to temp directories. Something once wrote state files into
      `packages/orchestrator`; they are deleted, but what wrote them is unknown.
- [ ] CI runs lint, format check, type check, build and tests on every push and PR.
- [ ] husky and lint-staged run on commit.
- [ ] The README describes what exists now, in short, plain English. It still shows
      `resource "file"`, which no provider has.
- [ ] `TASKS.md` matches what is actually done.
- [ ] Merged and empty branches are deleted (19).
- [ ] `.editorconfig`, a license file and a changelog are added.
