# Changelog

What changed in each release, newest first. Versions follow
[semantic versioning](https://semver.org): until 1.0.0, a minor version may change what
a configuration means or how the state file is written.

## Unreleased

### Added

- `count` and `for_each` on resources, modules and data sources, with addresses that name
  one instance, `local_file.a[0]` and `module.web["eu"]`. Adding `count` to a resource or
  a module that exists moves it to `[0]`.
- Types: a variable and an output may name one, objects may mark an attribute optional
  with a default, and every value carries its type through the engine. Sets hold one
  order, so reordering one is no change.
- Functions `length`, `tolist`, `toset`, `sensitive`, `nonsensitive`, `issensitive`,
  `upper`, `lower`, `join`, `lookup`, `merge` and `format`
- `for` expressions that make a list or an object, with `...` to group by key and `if`
  to keep some items
- `==`, `!=`, `&&`, `||`, `!` and the conditional `cond ? a : b`. A known condition reads
  only the result it picks
- `+`, `-`, `*`, `/`, `%` and `<`, `<=`, `>`, `>=` on numbers, which stay exact; a
  quotient keeps 34 significant digits
- A resource, a data source, a module or all their instances read as an object, a list
  or a map, and `.key`, `["key"]` and `[0]` into any value
- `locals` blocks, `path.module`, heredoc strings, string escapes, negative and decimal
  numbers, `/* ... */` comments, `description` on a variable and an output, and
  references that index with a reference or a call
- `validation` blocks on a variable, checked at plan, or at apply where the value is not
  known until then
- Provider schemas: resource and data source configuration is checked and converted to
  the type the schema names, and what a provider returns is checked too
- The provider plans what a resource will hold, and an apply plans each resource again
  and stops at a value that differs from the plan
- A refresh before each plan reads every resource back and shows what changed outside
  Clay; `--refresh=false` skips it
- Data sources, `local_file` the first, read at plan, or at apply when a resource they
  read changes. A saved plan carries what they read.
- Sensitive values, followed part by part through variables, locals, modules, `for`,
  resources and data sources, and hidden in plan, apply, `output` and `state show`
- `lifecycle` with `prevent_destroy`, `create_before_destroy` and `ignore_changes`, and
  deposed objects that a later plan destroys
- `apply --parallelism`: the resources of one layer run together, ten by default, and
  every failure of a run is reported

### Fixed

- Numbers stay exact from the configuration to the state and providers
- A saved plan is refused when it does not match its configuration: an action, an
  output or a data source missing or extra, an index `count` no longer gives
- State writes are queued so two never overlap, and each run has its own scopes
- A state or plan file that is not valid is refused and says what is wrong
- Ctrl-C during an apply starts nothing new, waits for what runs, saves it and releases
  the lock; a second Ctrl-C exits at once
- A failed apply keeps the outputs of the last finished run, and `state mv` and
  `state rm` leave them as they are
- `clay apply` exits 1 when it is not approved, and names `--yes` when its input is
  closed; `state rm` of an address the state does not hold exits 1
- Errors name what they are about by its address, point at where it is written, and
  quote no sensitive value

## 0.1.0 - 2026-09-21

The engine runs end to end: a configuration is parsed, planned against a state file and
applied by a provider.

### Added

- The `.clay` language: `resource`, `variable`, `output` and `module` blocks, strings,
  integers, booleans, lists, maps, references and `${...}` interpolation. A `data` block
  parses and is scoped, but every provider reads nothing back yet.
- A dependency graph that sorts resources, variables and outputs into layers and names a
  cycle or a reference to nothing
- A planner that produces create, update, replace, delete and no-op from the
  configuration and the state, with `forceNew` deciding a replacement
- Modules, loaded from a directory and nestable, with inputs from the caller and outputs
  back to it
- A state file with a serial, an atomic write, a backup and a lock, written after every
  change and holding what each resource reads from, so deletes run in reverse order
- Saved plans: `plan --out` writes the plan with the configuration it was made from, and
  `apply <file>` runs that and refuses it if the state has moved on
- The `clay` command: `init`, `validate`, `plan`, `apply`, `output` and
  `state list | show | mv | rm`
- The `local` provider: `local_file`, `random_string`, `null_resource` and `command_exec`
- Errors that name the file, line and column they came from, the block that holds them
  and the module instance, printed with the source line and a caret
