# Clay

An infrastructure-as-code engine in TypeScript. You describe resources in `.clay` files;
Clay compares them with what it created last time, shows what would change, and applies
it. Terraform is the reference for the problems it has solved well, not a
specification to copy.

It ships with one provider, `local`, whose resources live on the machine that runs it.

## Try it

Node 22.13 or newer, where `util.styleText` drops colour on a pipe and under `NO_COLOR`.

```sh
npm ci
npm run build
```

In an empty directory somewhere else, write a `main.clay`:

```
variable "name" { default = "world" }

resource "random_string" "suffix" { length = 6 }

resource "local_file" "greeting" {
  path = "./hello-${random_string.suffix.id}.txt"
  content = "Hello, ${var.name}!"
}

output "file" { value = "${local_file.greeting.path}" }
```

Then, with `clay` standing for `node <path-to-clay>/packages/cli/bin/clay.js`:

```sh
clay init        # writes an empty clay.state.json
clay plan        # shows the two resources it would create
clay apply       # creates them, after a yes
clay output      # file = "./hello-abc123.txt"
```

Edit `content`, run `plan` again, and it shows an update to the one file. Change `path`
and it shows a replacement, since the provider marks `path` as a value that cannot change
in place.

## The language

A file is a list of blocks. Values are strings, numbers, booleans, lists, maps and `null`,
each with a type. A string reads other values with `${...}`.

| Block                            | Does                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `resource "type" "name" { ... }` | Something the provider creates, updates and destroys             |
| `data "type" "name" { ... }`     | Something that already exists, read by the provider              |
| `variable "name" { default = }`  | A value the file takes; a module gets it from its caller         |
| `locals { name = }`              | Values the file works out once and reads by name                 |
| `output "name" { value = }`      | A value the file gives back; a module's caller reads it          |
| `module "name" { source = }`     | Another directory with its own `.clay` files, called with inputs |

On top of these:

- `count` and `for_each` make many instances of a resource, a data source or a module.
- Types: `type = set(string)`, objects with `optional(number, 80)` attributes.
- Functions `length`, `tolist`, `toset`, `sensitive`, `nonsensitive`, `issensitive`,
  `upper`, `lower`, `join`, `lookup`, `merge`, `format`.
- `for` expressions that make a list or an object, with `if` to keep some items.
- `==`, `!=`, `&&`, `||`, `!`, the conditional `cond ? a : b`, `+`, `-`, `*`, `/`, `%` and
  `<`, `<=`, `>`, `>=`.
- Sensitive values, followed part by part and hidden wherever they would be printed.
- `lifecycle` with `prevent_destroy`, `create_before_destroy` and `ignore_changes`.
- `depends_on` in a resource, a data source, a module call or an output, for an order no
  reference shows.

`docs/LANGUAGE.md` says what each of these does, and `docs/GRAMMAR.md` how it is written.

Not there yet: `destroy`, values for root variables from the command line, and more than
one file per module. `docs/TASKS.md` has the full list.

## Commands

| Command                  | Does                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `clay init`              | Creates an empty state file, or says so if one is already there                                           |
| `clay validate`          | Resolves references and checks values with the schema and the provider; reads no state and no data source |
| `clay plan [--out file]` | Shows what `apply` would do; `--out` saves the plan with its configuration                                |
| `clay apply [plan] [-y]` | Runs the plan it shows, or a saved one; `-y` skips the question                                           |
| `clay output [--json]`   | Prints the root outputs from the last apply; `--json` gives each with its type, a sensitive one too       |
| `clay state list`        | Lists the resources in state, and `<addr> (deposed)` for an address that holds deposed objects            |
| `clay state show <addr>` | Prints one resource as it is in state, and each deposed object under it                                   |
| `clay state mv <a> <b>`  | Renames a resource in state, so the next plan does not recreate it                                        |
| `clay state rm <addr>`   | Forgets a resource, and its deposed objects, without destroying them                                      |

A saved plan carries the configuration it was made from and the state it was planned
against. `apply` runs that configuration, not the one on disk now, and refuses the plan
if the state has changed since.

## Resources

| Type            | Attributes                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `local_file`    | `path` (replaces when it names another file), `content`                                                    |
| `random_string` | `length`, `special` (`false` if left out), both replace on change; the string is its `id` and its `result` |
| `null_resource` | `triggers`, a map; does nothing, and another resource can read its `id` to run after it                    |
| `command_exec`  | `command`, `cwd`; runs on create and on every update, and keeps what it printed in `stdout`                |

Each has an `id` the provider makes and keeps until the resource is replaced: the file's
full path, the string, or a random UUID. Only the provider makes `id`, `result` and
`stdout`, so setting one in the configuration is refused; `null` sets none. A value made
from a sensitive one is sensitive too: `local_file.id` where `path` is, `stdout` where
`command` or `cwd` is.

## How a run goes

1. Each resource in state is read back from its provider, so a change made by hand shows
   up. A resource found gone is made again, or forgotten if the configuration dropped
   it. `plan` and `apply` take `--refresh=false` to skip this and plan against the state
   alone. An apply writes what was read, even when nothing else changes. A saved plan is
   applied as it was made, so `apply <plan>` reads nothing and refuses the flag. A read
   that returns a value not known, or a name the schema does not have, stops the run as
   a bug in the provider.
2. The parser turns the `.clay` files of the directory and of every module they name
   into a tree, with the file, line and column on every node.
3. The graph builder links each resource, variable, local and output to what it reads,
   and sorts them so nothing runs before what it needs. A cycle or a reference to
   nothing stops here.
4. Each value is resolved in that order and held to the type its schema names. The
   provider checks it and plans what the resource will hold: a value it computes is
   known after apply once anything changes, unless it can work it out sooner, as
   `local_file` does its id from an absolute path. It also says which changes replace
   the resource. A plan that changes a value the configuration sets is refused. The
   planner compares each plan with the state and lists the actions: create, update,
   replace, delete, or nothing.
5. `apply` runs the actions a layer of the graph at a time, ten at once or as many as
   `--parallelism` says, which a saved plan takes too. It deletes in reverse order and
   writes the state after each action, so a failure leaves everything done before it on
   disk. When one fails, the ones already running finish and none starts, and every
   failure is reported at the end. Before each create, update or replace, the provider plans
   it again with what is known by then. A value the plan showed that comes out
   different, or a replace where the plan showed an update, stops the run before
   anything changes. What the provider returns is held to that plan. The state is
   written to a temporary file and renamed, a backup is kept, and a lock file stops two
   runs at once. The first Ctrl-C starts nothing new, waits for what runs, saves it and
   unlocks; a second exits at once. A terminal sends Ctrl-C to a `command_exec` command
   too, which then fails.

An error says where it was written:

```
Planning failed: var.tags is a tuple and cannot be joined into a string

  on modules/app/main.clay line 4, in resource "local_file" "a":

  4:   content = "tags: ${var.tags}"
                          ^

  in module.app
```

A control character in an error, from the configuration, a path or a provider, prints as
a character of its own, `␛` for an escape, so it cannot move the cursor or start a terminal
sequence.

`plan`, `apply`, `state` and `output` write a control character or direction mark in a
quoted value, key or address as JSON does, `"a\u007f"`, so `output --json` reads back as
the same value.

## Packages

| Package          | Does                                                           |
| ---------------- | -------------------------------------------------------------- |
| `parser`         | Turns `.clay` files into an AST                                |
| `graph`          | Dependency graph, sorted into layers                           |
| `contracts`      | Interfaces shared by the engine and providers                  |
| `state`          | Reads and writes state, with a lock and a backup               |
| `planner`        | Compares config with state and lists the actions               |
| `orchestrator`   | Loads modules, resolves references and runs the plan           |
| `cli`            | The `clay` command                                             |
| `provider-local` | `local_file`, `random_string`, `null_resource`, `command_exec` |

Inside `orchestrator/src`, a folder imports only from the folders above it. `index.ts` is
the way in; the other files beside the folders are shared by all:

| Folder        | Does                                                         |
| ------------- | ------------------------------------------------------------ |
| `values`      | Holds a value with its type and sensitive marks, converts it |
| `config`      | Reads the files, loads the module tree, holds each scope     |
| `instances`   | Expands `count` and `for_each` into instances                |
| `providers`   | Calls a provider and checks what it returns                  |
| `expressions` | Evaluates expressions, functions and operators               |
| `graph`       | Builds the dependency graph from the blocks                  |
| `plan`        | Plans each resource and orders the apply                     |
| `checks`      | Refuses a configuration or a plan before anything runs       |
| `run`         | Wires one run together, loads it and applies the plan        |

## Develop

```sh
npm ci
npm run build
npm test
npm run lint
npm run type:check
npm run format
```

A commit runs eslint and a prettier check on the staged files; CI runs the format check,
lint, type check, build and tests on every push and pull request. `docs/TASKS.md` lists
what comes next.

## License

ISC
