# Tasks

What Clay does today is in the README. This is what comes next, in the order it is
worth doing. Terraform is named where it has solved the same problem.

## Bugs

Wrong behaviour, each seen and reproduced. These come before everything below, one
change each.

- [x] A module that names itself, or two that name each other, overflow the stack.
      `ModuleLoader` keeps no record of the directories on the path it is loading, so a
      `source` cycle recurses until Node dies. The graph refuses a reference cycle by
      name; a module cycle should be refused the same way
- [x] A module input the module never declares is accepted, and a misspelled one falls
      back to the default in silence. `declareInputs` sets every attribute of the
      `module` block as a variable, and nothing checks the module has a `variable` of
      that name; `contnet = "x"` applies the default and says nothing. Terraform: "An
      argument named "contnet" is not expected here"
- [x] A reference that reads deeper than what it names drops the parts in between in
      silence: `var.v.bogus` gives the variable, and `local_file.a.tags.content` reads the
      `content` attribute as if `tags` were never written. Both were seen in a plan that
      said nothing. A reference reads one attribute until nested access lands
- [x] An attribute a `variable` block does not use is accepted in silence.
      `declareVariables` reads `default` and nothing else, so `descriptoin = "x"` is
      dropped and `defualt = "x"` is reported as `variable "v" has no value`, which names
      the wrong problem. `type` and `description` are read by nobody either, so what a
      `variable` block may hold is the call the fix makes
- [x] A module that declares `variable "source"` can never be given one. `declareInputs`
      skips the key, because the caller's `source` is the module's path, so a declaration
      with a default falls back to it in silence and one without fails with
      `module.m: variable "source" has no value`, which names the caller's input as
      missing when it was written. Terraform reserves the name and refuses the
      declaration
- [x] A resource named `a.b` is created and can never be addressed again. The parser
      takes any string as a name, `Address.toString` joins with dots and `Address.parse`
      splits on them, so `state show`, `state rm` and a reference all fail on the key an
      apply wrote. The same for a type or name spelled `module`. A name is an identifier,
      as in Terraform
- [x] `LocalBackend.write` swallows every backup failure, not only "nothing to back up".
      The `catch` around `access` and `copyFile` is bare, so when the backup cannot be
      written the old state is replaced anyway, with no backup and no message. Only
      `ENOENT` on `access` means a first write
- [x] A map key can impersonate the unknown value. `UNKNOWN` is a plain object with the
      key `@@clay/unknown`, so `triggers = { "@@clay/unknown" = true }` is unknown to the
      planner and plans an update forever. A sentinel is something a configuration cannot
      spell
- [x] An integer above 2^53 is rounded in silence: `12345678901234567890` plans as
      `12345678901234567000`. A number is kept exactly from the configuration to state,
      a plan file and a provider, as Terraform keeps it

## 1. Language

The parser takes integers, plain strings and one level of attribute access. A real
configuration hits each of these early.

- [ ] Negative and decimal numbers; only `[0-9]+` lexes today. `ExactNumber` already
      holds both, and reads `-0` as `0`, so what is left is the lexer and the grammar
- [ ] String escapes: `\"`, `\n`, `\\`, and `$${` for a literal `${`
- [ ] Nested access: `local_file.a.tags.env` and `var.list[0]`; today `[` after a
      reference is a parse error, and a reference that reads deeper than one attribute is
      refused where it is read
- [x] A reference is a type, not a string. Today it travels as `string[]` and four places
      split it on dots to read a part back. An instance key cannot be added to a shape
      that thin, so this comes before `count`
- [ ] `count` and `for_each`, with `[0]` and `each.key` access; addresses grow an instance
      key, the way Terraform's `addrs.AbsResourceInstance` does
- [ ] `path.module`, `path.root` and `path.cwd`, so a module can name a file next to
      itself; a relative path is resolved from where `clay` runs today
- [ ] A module `source` has a kind. Terraform reads a local path only when it starts with
      `./` or `../` and treats anything else as a registry address; Clay joins whatever it
      is onto the parent directory, so an absolute path is read as well

## 2. Engine

### Refresh

Terraform reads every resource from its provider before the diff, so a change made by
hand shows up in the plan. Clay plans against what it last applied.

- [ ] `read()` on every resource type; today each returns `{}`
- [ ] State holds what the provider returns, not only the inputs that were sent
- [ ] `plan` refreshes first, `-refresh=false` skips it; a plan that writes state has to
      take the lock, as `apply` does

### What a plan carries

A `PlanAction` holds the attributes as the parser wrote them, so `apply` is handed the
configuration again and resolves every reference a second time. Terraform's plan carries
finished values, which is what lets `apply` promise it will do what the plan showed.

- [ ] A plan carries resolved values, and `apply` runs them without resolving again
- [ ] What a saved plan needs the configuration for is only what it cannot carry

### Computed attributes

`create` returns one string, the id. A `random_string` is read through `.id`, a
`command_exec` loses its output, and an output that names an attribute the resource does
not have is only caught after the resource is created. Terraform's providers return the
whole resource and mark which attributes are computed.

- [ ] `create` and `update` return the resource's attributes; state holds them
- [ ] Schema marks computed attributes, so `plan` can refuse a reference to an attribute
      that will never exist
- [ ] `command_exec` exposes `stdout` and `exit_code`; `random_string` exposes `result`

### Schema-driven validation

`SchemaDefinition` carries `type`, `required`, `elemType` and `schema`, and the engine
reads only `forceNew`.
Every resource validates its inputs by hand.

- [ ] The engine validates inputs against the schema before it asks the provider
- [ ] Providers keep `validate` for what a schema cannot say
- [ ] A resource with a value that is not known yet has its known values checked. Today
      `plan` skips the whole resource, because a provider's `validate` would report a
      missing required attribute; a schema check knows the attribute is there and unknown
- [ ] `SchemaType` knows a `set`, whose order is not a change. Every list is compared in
      order today, so writing the same members in another order plans an update

### Data sources in the graph

Data sources are read while the config loads, before any resource exists, so one that
reads a resource fails at plan. `plan` and `apply` each read them, so an apply reads
twice. The local provider's `read` returns `{}` for every type, so no data source reads
anything yet.

- [ ] Data sources are graph nodes, read in dependency order and once per run
- [ ] A data source fed by a pending resource is `(known after apply)`
- [ ] Their values travel in the plan, as in Terraform, so `apply` reads none of them
      again. `runPlan` still parses and builds the graph on its own, since a saved plan
      brings its own configuration; that stays, and only the second read goes
- [ ] `local_file` as a data source reads the file
- [ ] `clay validate` stops reading them. Checking a configuration asks the provider for
      real data today, so validating needs whatever the data source talks to

### Parallel apply

The graph sorts into layers that can run in parallel, and the runner takes them one at a
time. Runs in parallel need a context of their own: one `ScopeManager` and one
data-source map per engine, cleared on load, serve one run at a time.

- [ ] A run carries its own scopes and data-source values. The engine holds one of each
      and clears them on load, which is what limits it to one run at a time
- [ ] Resources in one layer run together; state is written once per layer

### Lifecycle

- [ ] `lifecycle { create_before_destroy = true }`: today a replacement deletes first
- [ ] `prevent_destroy`: the plan refuses to delete the resource
- [ ] `ignore_changes`: named attributes do not count as a change

### Provisioners

`command_exec` is a resource, so a command has state of its own. Terraform's provisioners
run as a step of another resource instead.

- [ ] `provisioner "local-exec" { command = "..." }` inside a resource, run after create
- [ ] `remote-exec` and `file`, once a resource can carry a connection

## 3. State

### Backends

The state is always the file `clay.state.json` next to the configuration. Where it lives
should be the workspace's choice, written once and read by every command, the way
Terraform has it since backends replaced `-state`.

- [ ] A `clay { backend "local" { path = "..." } }` block in the configuration
- [ ] `init` reads it, checks the backend answers, and remembers the choice
- [ ] A factory builds the backend from the block; `StateBackend` is the contract it
      already has to meet
- [ ] The CLI stops reading `LocalBackend.path`. It names the state file in its messages
      through a field only the local backend has, so no other backend can be put in its
      place
- [ ] An HTTP backend, since it needs no SDK: read, write, lock and unlock over four
      requests
- [ ] `init` offers to move the state when the block names a different backend than the
      one in use
- [ ] An S3 backend, with the lock a second run has to wait for; an Azure Blob backend

### Format

- [ ] A state a newer Clay wrote is refused, which is right, but an older one has no way
      forward either. Version 2 needs an upgrade step that reads version 1, the way
      Terraform's `states/statefile` upgrades on read

### Commands

- [ ] `clay force-unlock`: a run that dies leaves its lock behind, and the error names
      the file; this removes it, the way Terraform's does
- [ ] `clay import <address> <id>`: take over a resource that exists but is not in state
- [ ] `clay state pull`: print the state as JSON, for a script or a backup
- [ ] Workspaces: `clay workspace new | select | list`, one state per workspace

## 4. Providers

The CLI imports the one provider, `local`, and registers it; the registry keys providers
by resource type, and no `provider` block exists yet.

- [ ] `contracts` splits in two. It holds both the engine's contract with a provider
      (`Provider`, `Schema`) and value types the engine shares with itself (`Address`,
      `State`), so a provider written elsewhere would depend on the engine's own types.
      This comes before a provider can be loaded from a package
- [ ] Provider instances with configuration: `provider "aws" { region = "..." }`, and
      aliases for a second instance of the same provider
- [ ] Loading a provider from a package instead of a hard-coded import
- [ ] A provider is told where the run is. Each reads `process.cwd()` for itself, so a
      relative path means whatever the shell was in
- [ ] `null_resource` acts on its `triggers`. A change to them plans an update and the
      update does nothing
- [ ] A first remote provider to prove the shape, small enough to keep tests real: an
      HTTP or GitHub provider before an AWS one

## 5. Errors and tooling

- [ ] Errors about a configuration that carry no position. Each is thrown where the
      position is at hand, and each prints as one bare line: a `module` block with no
      `source`, a `source` that names no file, a `source` cycle, a `variable` with no
      value, and the graph's dependency cycle, which knows the node but not the line and
      prints the graph's own key, `vars:a`, for a variable the configuration spells `var.a`
- [ ] An attribute name has no position of its own. Only its value is a node, so an
      error about the name points a caret at the value next to it
- [ ] "Did you mean": a reference to a name one edit away from a declared one says so
- [ ] Provider errors carry what to do next, not only what went wrong
- [ ] An output that fails to resolve reports a failure. `resolveOutput` runs outside the
      step's `try`, so a throw there ends the run with no `failed` event and nothing said
- [ ] An output may be named `__proto__`. The runner collects outputs into a plain object,
      where that name sets a prototype instead of a key, so the output disappears
- [ ] `apply` says a missing file is missing the same way twice. A missing plan file and a
      missing configuration are reported with different prefixes today
- [x] `Address.parse` says `got 1 parts` when it refuses an address
- [ ] `clay graph`: the dependency graph in DOT
- [ ] `clay fmt`: one layout for every file, so diffs show changes and not style

### Code health

Nothing here changes what Clay does. Each is a place the next change has to work around.

- [ ] `ActionExecutor.executeCreate`, `executeUpdate` and `executeDelete` are public only
      because tests call them
- [ ] `validatePlanFile` is exported although `parsePlanFile` is the way in
- [ ] `Graph.getNode` is followed by `!` at four call sites; the graph should hand back a
      node or say it has none
- [ ] `ModuleLoader.loadModuleTree` is `async` with nothing to await, and walks the same
      statements as `loadChildModule` does
- [ ] The root address is spelled three ways
- [ ] `PlanRunner` reads `?.dependencies ?? []`, which reads a missing state entry as one
      with no dependencies
- [ ] The CLI rebuilds the module file layout that `RecordingFiles` already snapshotted
- [ ] A `state show` test feeds a resource with no `attributes`, which `parseState` now
      refuses to read; the branch it covers may be unreachable
- [ ] `ActionExecutor.executeUpdate` says "the plan resolved these against an older
      state", but `action.attributes` is the parsed block and was never resolved;
      `executeCreate` does the same resolve with no comment
- [ ] `LoadedResource.uniqueId` is `address.toString()` under a second name
- [ ] Comments that restate the code: the `// e.g., "my_file"` trailers in `ast.ts`, the
      `// {` and `// }` trailers in `tokens.ts`, the `forceNew` explanations in the local
      provider

### Test health

- [ ] `ReferenceResolver.spec.ts` has a test titled "resolve Array of References
      recursively" that asserts the array comes back unresolved, under a 28-line
      transcript of someone reading the code, naming an `Orchestrator.convertAttributes`
      that does not exist. It feeds a raw array, which the resolver is never handed;
      attributes arrive as a `List` node
- [ ] Two `Orchestrator.advanced` tests are titled for dependency order and for a
      reference to another resource, and each asserts only that two resources were
      created; both pass with every graph edge removed
- [ ] Comments in `ModuleLoading.spec.ts` and `ModuleDataFlow.spec.ts` name
      `Orchestrator.run` and `Orchestrator.ts`, which do not exist, and ask questions
      rather than state reasons
- [ ] `describe` titles say "Phase 4" and "Phase 5", which mean nothing in the repo
- [ ] `ApplyPlan.spec.ts` says the CLI cannot be driven from a test, and four
      neighbouring specs drive it
- [ ] `Graph.spec.ts` hedges that a sort "depends on implementation details" and asserts
      the flattened list, where the layers are deterministic and should be asserted
- [ ] Regression tests explain what used to happen; a comment says what the test pins
- [ ] Test comments of the `// Setup`, `// Verify`, `// Mock X` kind restate the line
      below them, across `Orchestrator.spec.ts`, `StateManager.spec.ts`, `Graph.spec.ts`
      and others
- [ ] No test puts a reference inside a list: `tags = [local_file.a.id]`. With
      `resolveList` passing a `Reference` node through unresolved, all 452 tests pass
- [ ] No test has a delete fail. With `PlanRunner` ignoring a failed delete and going on
      to write outputs, all 452 tests pass; the `failed` event, the kept state entry and
      the released lock on that path are unpinned. A replace whose create fails after
      the delete is untested the same way
- [ ] Data sources have no end-to-end test; the only `data` block in `e2e` is an error
      case, since `LocalProvider.read` returns `{}`
- [ ] The two `command_exec` "execute" tests assert only that an id came back; they pass
      with the command never run and with `cwd` ignored
- [ ] `Orchestrator.spec.ts` "should register a provider" asserts only `not.toThrow`,
      and passes with registration removed
- [ ] `ModuleDataSources.spec.ts` still hands one `emptyState()` to every test; its two
      siblings were fixed and it was missed. `ModuleOutputResolver.spec.ts` shares one
      `ScopeManager` the same way, and its "not found" test passes only because no
      earlier test set that key
- [ ] `ModuleLoading`, `ModuleDataFlow` and `ModuleDataSources` stub `plan` and hand-write
      the actions, `modulePath` included, so the module address they appear to test is
      their own fixture: with every resource given a root address, all 11 pass and ten
      e2e tests fail. Rewrite them against a real `StateManager` in a temp directory, as
      `Orchestrator.spec.ts` is; what they alone pin is a missing `source`, nesting deeper
      than one level, and per-module data-source scope
- [ ] Unit tests an e2e already covers for real: `Init.spec` "should initialize state";
      `Apply.spec` `--yes`, both plan-file applies, the rejected plan file and the failed
      apply. The rest of each file pins what an e2e cannot see and stays
- [ ] `ModuleLoading.spec.ts` asserts `toHaveProperty(expectedKey)` twice in a row

## 6. Later

Ideas that need the sections above first.

- A programmatic API: `plan()`, `apply()`, `destroy()` with events, for use from a script
- Configuration in TypeScript, `clay.config.ts` with `defineConfig`, typed per provider
- Snapshots of state with rollback
- A plan as an HTML page, with the diff highlighted
- Cost estimation: a provider says what a resource costs, the plan sums the change
- A language server: completion, go to definition, hover; a VS Code extension on top
- Benchmarks on large configurations, and fuzzing the parser and the state reader

## Done

What shipped, by area. The README says how each works today.

- [x] Language: `resource`, `data`, `variable`, `output` and `module` blocks; strings,
      integers, booleans, lists and maps; references and `${...}` interpolation; comments;
      block kinds usable as attribute and map names; a duplicate block, attribute or key
      refused
- [x] Parser errors and resolve errors carry the file, line and column, the block and
      the module instance, and the CLI prints the source line with a caret
- [x] Dependency graph with cycle detection, sorted into layers; variables and outputs
      are nodes, so a value is resolved after what it reads
- [x] Planner: create, update, replace, delete and no-op from config against state;
      `forceNew` decides replace; a value fed by a pending resource is unknown
- [x] Modules: loaded from a directory, nested, inputs from the caller, outputs to the
      caller; reaching inside one is refused
- [x] Data sources: `data` blocks read through the provider's `read`, scoped per module
- [x] State: JSON file with a serial, atomic write, backup, lock; written after every
      change; dependencies recorded so deletes run in reverse order
- [x] Saved plans: `plan --out` writes the plan with its configuration and modules;
      `apply <file>` runs it and refuses it if the state moved on
- [x] CLI: `init`, `validate`, `plan`, `apply`, `output`, `state list | show | mv | rm`
- [x] Local provider: `local_file`, `random_string`, `null_resource`, `command_exec`
- [x] Tests: unit tests per package and end-to-end tests that run the engine with the
      real provider in a temp directory; CI on every push and pull request; eslint and
      prettier on commit
