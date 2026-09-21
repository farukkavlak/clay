# Tech debt

What has to be fixed before any new feature. Audited on 2026-09-17, rechecked on
2026-09-19 and 2026-09-20.

## Where things stand

385 tests pass, and so do the type check and the build. Lint shows 11 warnings, and
`npm audit` is clean.

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
- [x] A string that was one interpolation lost its value's type: `"${var.list}"` became
      `a,b` and `"${var.n}"` became `"8"`. Now a string that is one interpolation is the
      value itself, as in Terraform since 0.12, and text around an interpolation makes a
      string; a list or map in such text is refused instead of printed as
      `[object Object]`.
- [x] The CLI printed a resource without its module: `plan`, `apply` and the applied
      lines all said `local_file.f` for `module.m.local_file.f`, so two modules with the
      same resource name were told apart by nothing. They print the full address now. The
      apply summary said `Resources: 1 changed` for a create; it counts added, changed and
      destroyed apart, a replacement once in each, as the plan summary does.
- [x] The state file was written in place. A run killed halfway through `writeFile` left
      a torn file and the `.bak` was not restored. The state is now written beside the
      file and renamed over it, as Terraform writes it, so the file on disk is always the
      old state or the new one.

Found by the 2026-09-20 review of this section:

- [x] `apply` ran a plan nobody saw. It planned without the lock, showed the plan, asked,
      and then `run` took the lock and planned again, applying whatever came out. A run
      that finished while the question was open changed what the second plan did.
      Terraform holds the lock from the plan to the end of the apply. Cheaper here:
      `apply` hands the plan it showed to `runPlan`, which refuses it once the serial has
      moved on, and `run` is gone. The config is loaded twice per apply now, not three
      times.
- [x] A state write that failed after a failed action was swallowed: `step` wrote with
      `.catch(() => undefined)`, so a replacement that deleted, failed to create and then
      could not save left a state that still listed the resource, and the user saw only
      the create error. Terraform reports the failed save as an error of its own. The
      `failed` event carries it now, and `apply` prints it before the action's error.

## 2 — dependencies

- [x] Each package lists the `@clay/*` packages it imports. Only the CLI listed any; the
      orchestrator, the planner, `state` and the local provider resolved theirs through
      the hoisted workspace links, with nothing saying so.
- [x] Shared dev tools (typescript, vitest, eslint, esbuild, `@types/node`) are listed
      only in the root. Three packages asked for vitest 0.34 and eslint 8, so each got a
      nested copy and ran its tests on a vitest four major versions behind the rest; the
      copies hid six constructor mocks, written as arrows, that vitest 4 refuses.
      Everything runs on vitest 5 now.
- [x] Unused dev dependencies removed: the react, react-hooks and i18next ESLint plugins,
      and `ts-node`.
- [x] `npm audit` is clean. The nine left after the tools moved to the root were all
      transitive, under eslint, the unicorn plugin and inquirer; `npm audit fix` took them
      within their ranges, so only the lockfile moved.
- [x] `orchestrator` and `planner` point `main` at `dist`, not at `src`, with `types`
      beside it like the other six. Tests read every package's source through an alias in
      the root `vitest.config.mts`, so a stale or missing `dist` can neither pass nor fail
      them; the CLI's tests had read the orchestrator's source only because `main` said
      so. The root `build` now names the packages in dependency order, since the CLI's
      bundle reads the orchestrator's `dist` and npm's own order is alphabetical.
- [x] The CLI uses Node built-ins instead of chalk (`util.styleText`) and inquirer
      (`readline/promises`); 46 packages left with them. The prompt takes only a plain
      `yes` now, as Terraform's does, so a stray Enter runs nothing; input that ends
      first, Ctrl+C included, cancels with exit 0, where Terraform exits with an error.
      commander stays:
      `util.parseArgs` reads flags, and the subcommands, the help text and the argument
      checks it gives would be a hundred lines of our own for a package that has no
      dependencies of its own.
- [x] `engines.node` is `>=22.13`: `util.styleText` leaves the colour out on a pipe and
      under `NO_COLOR` from that version on. vitest 5 promises `^22.12 || ^24 || >=26`;
      the range should not claim more than the tools do.
- [x] A package's build does not bundle the `@clay/*` packages it imports. Every `dist`
      was an esbuild bundle, so the CLI carried its own copy of the parser, the planner and
      the rest, and so did the orchestrator; the planner sat in the CLI's bundle twice.
      esbuild is gone: `tsc -b` emits each package from its own `tsconfig.json`, whose
      `references` name the packages it imports, so the build order comes from the graph
      instead of a list in the root script, and `dist` holds one package's code and
      nothing else.
- [x] `tsconfig.json` fits this repo: `experimentalDecorators`, the `cdk.out` exclude and
      the flags `strict` already implies are gone, and `target` and `lib` are `es2022`.
      `tsconfig.base.json` holds the options, each package extends it with `rootDir`,
      `outDir` and its references, `tsconfig.build.json` lists the packages for `tsc -b`,
      and the root `tsconfig.json` type-checks every source and test against the sources
      through `paths`, so `type:check` needs no build.
- [x] `moduleResolution` was `Node`, which TypeScript 6 refuses; it is `node16` now, with
      `module` to match, and the output stays CommonJS. vitest is an ES module, so its
      config is `vitest.config.mts` and reads `import.meta.dirname` without a lint
      exception.
- [x] The plan's provider errors keep the provider's error as their cause. `lib` is
      `es2022` now, so `new Error(message, { cause })` compiles.
- [x] `IState` moved to `contracts`, next to `IResource`, with `emptyState()` beside it in
      place of the `{ version: 1, serial: 0, resources: {} }` that `init`, `LocalBackend`
      and `Orchestrator.validate` each spelled out. `planner` depended on `@clay/state`
      only for that type and no longer does; the shape state is written in is a contract
      every side has to agree on, and keeping it inside one side is how the planner
      drifted away from it. `Address` went the same way: the planner spelled the state
      key by hand in `getResourceKey` and the orchestrator in `Address.toString`, so the
      two agreed by luck; the planner uses `Address` now.

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
      not twice. `plan` does all three, and `runPlan` does them again for the plan it is
      handed.
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
      diff. `newOrchestrator` with the `LocalProvider` registration is copied into `plan`,
      `apply` and `validate`. A missing provider is reported in three wordings:
      `No provider handles`, `Provider for data source type ... not registered` and
      `No provider registered for resource type`.
- [ ] Comments that only restate the code are gone (`// Mock Provider for testing`), and
      so are the stale ones: `loadContext` carries two doc blocks, one for `plan`;
      `IResource` says it comes from the parser when it is a state entry; `StateManager`
      promises S3 and Azure. `loadContext` also spells `import('./components/ModuleLoader')`
      inline for a type it already imports.
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
- [ ] A resolve error names the reference but not the resource that holds it, so
      `cannot be joined into a string` leaves the user searching when two resources read
      the same thing. `planResource` can wrap it with the address, as
      `checkWithProviders` does.
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

- [x] `npm run clay` pointed at a file that doesn't exist. The script is gone with
      `ts-node`; the CLI is tried with `node packages/cli/bin/clay.js` in a temp directory.
- [ ] Test fixtures match the state shape: five mocked states still carry a `variables`
      key that state no longer has.
- [ ] Tests write only to temp directories. Something once wrote state files into
      `packages/orchestrator`; they are deleted, but what wrote them is unknown.
- [ ] CI runs lint, format check, type check, build and tests on every push and PR.
- [ ] husky and lint-staged run on commit.
- [ ] The README describes what exists now, in short, plain English. It still shows
      `resource "file"`, which no provider has.
- [ ] `GRAMMAR.md` matches the parser: it lists `4.5` as a number the lexer does not
      take, has no `LBRACKET`, `RBRACKET` or `COMMA` in the token table, and leaves `data`
      and `module` blocks out of the block list and the AST section.
- [ ] `TASKS.md` matches what is actually done.
- [ ] Merged and empty branches are deleted (19).
- [ ] `.editorconfig`, a license file and a changelog are added.
