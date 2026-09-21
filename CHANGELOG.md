# Changelog

What changed in each release, newest first. Versions follow
[semantic versioning](https://semver.org): until 1.0.0, a minor version may change what
a configuration means or how the state file is written.

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
