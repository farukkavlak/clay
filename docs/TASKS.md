# Tasks

What Clay does today is in the README. This is what comes next, in the order it is
worth doing. Terraform is named where it has solved the same problem.

## 1. Language

The parser takes integers, plain strings and one level of attribute access. A real
configuration hits each of these early.

- [ ] Negative and decimal numbers; only `[0-9]+` lexes today. A `-0` read back from
      state would then differ from a `0` in the configuration, which the diff has to
      settle
- [ ] String escapes: `\"`, `\n`, `\\`, and `$${` for a literal `${`
- [ ] Nested access: `local_file.a.tags.env` and `var.list[0]`; today `[` after a
      reference is a parse error, and the resolver reads the first two segments as the
      address and the last as the attribute, dropping what lies between
- [ ] A reference is a type, not a string. Today it travels as `string[]` and four places
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

- [ ] "Did you mean": a reference to a name one edit away from a declared one says so
- [ ] Provider errors carry what to do next, not only what went wrong
- [ ] An output that fails to resolve reports a failure. `resolveOutput` runs outside the
      step's `try`, so a throw there ends the run with no `failed` event and nothing said
- [ ] An output may be named `__proto__`. The runner collects outputs into a plain object,
      where that name sets a prototype instead of a key, so the output disappears
- [ ] `apply` says a missing file is missing the same way twice. A missing plan file and a
      missing configuration are reported with different prefixes today
- [ ] `Address.parse` says `got 1 parts` when it refuses an address
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
