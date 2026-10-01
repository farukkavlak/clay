# Clay

An infrastructure-as-code engine in TypeScript. You describe resources in a `main.clay`
file; Clay compares it with what it created last time, shows what would change, and
applies it. Terraform is the reference for the problems it has solved well, not a
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

A file is a list of blocks. Values are strings, numbers, booleans, lists and maps, and a
string can read other values with `${...}`. A string over many lines is a heredoc:
`<<-EOT`, the lines, then `EOT`.

| Block                            | Does                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `resource "type" "name" { ... }` | Something the provider creates, updates and destroys           |
| `variable "name" { default = }`  | A value the file takes; a module gets it from its caller       |
| `output "name" { value = }`      | A value the file gives back; a module's caller reads it        |
| `module "name" { source = }`     | Another directory with its own `main.clay`, called with inputs |

A resource with `count = 3` makes three instances, `type.name[0]` to `type.name[2]`, and
`count.index` inside the block is the index of the one being made. Another value reads
one of them: `local_file.logs[0].content`. Adding `count` to a resource that exists moves
it to `[0]` instead of making it again. With `for_each = { web = 80, api = 8080 }`, or a
list of strings, it makes one instance for each key, `type.name["web"]`, and `each.key`
and `each.value` inside the block are the key and value of the one being made. A module
call takes `count` too: with `count = 3`, `module.web[0]` to `module.web[2]` are each a
whole copy of the module, and `count.index` in the call's inputs is the index of the copy.
Adding `count` to a module that exists moves what is in it to `module.web[0]` in the same
way. A module call takes `for_each` too, `module.web["eu"]`, with `each.key` and
`each.value` in its inputs. A `for_each` map needs its keys at plan time, not its values:
`{ a = random_string.s.id }` plans `["a"]` with `each.value` unknown.

References: `var.name`, `local_file.a.content`, `module.m.out`, `module.web[0].out`, and
`random_string.s.id` for what the provider assigned. A reference reads into a map or a
list with `.key`, `["key"]` and `[0]`: `var.tags.env`, `var.names[0]`. A resource to be
created or changed is read at plan time as its provider plans it, so `random_string.s.length`
is known, and so is `local_file.a.id` when only its content changes; what only the apply
makes, such as the id of a new resource or `random_string.s.result`, is unknown and shown
as such. A name the resource will never have, one the configuration does not set and the
provider does not compute, is refused at plan. A list or a map is known as far as its
items are:
`{ a = random_string.s.id, b = "x" }` plans as `{"a":(known after apply),"b":"x"}`.
A set is unknown as a whole while one member is, since that member may turn out the
same as another.
Reaching inside a module (`module.m.local_file.a`) is not allowed; a module speaks
through its outputs. `path.module` is the directory of the module it is written in,
relative to the root, so `"${path.module}/index.html"` names a file next to the module.

`docs/GRAMMAR.md` has the full grammar.

## Commands

| Command                  | Does                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `clay init`              | Creates an empty state file, or says so if one is already there                        |
| `clay validate`          | Resolves references and checks values with the schema and the provider; reads no state |
| `clay plan [--out file]` | Shows what `apply` would do; `--out` saves the plan with its configuration             |
| `clay apply [plan] [-y]` | Runs the plan it shows, or a saved one; `-y` skips the question                        |
| `clay output [--json]`   | Prints the root outputs from the last apply                                            |
| `clay state list`        | Lists the resources in state                                                           |
| `clay state show <addr>` | Prints one resource as it is in state                                                  |
| `clay state mv <a> <b>`  | Renames a resource in state, so the next plan does not recreate it                     |
| `clay state rm <addr>`   | Forgets a resource without destroying it                                               |

A saved plan carries the configuration it was made from, the state it was planned
against and what the refresh read. `apply` runs that configuration, not the one on disk
now, against what the refresh read, and refuses the plan if the state has changed since.
On every apply, a value the plan showed as known that now comes out otherwise stops the
run before that resource is touched. A provider that makes a resource other than the plan
showed stops the run too: what it made is kept in state, and the error lists each value
that differs.

## Resources

| Type            | Attributes                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------- |
| `local_file`    | `path` (replaces on change), `content`                                                      |
| `random_string` | `length`, `special`, both replace on change; the string is its `id` and its `result`        |
| `null_resource` | `triggers`, a map; does nothing, and another resource can read its `id` to run after it     |
| `command_exec`  | `command`, `cwd`; runs on create and on every update, and keeps what it printed in `stdout` |

Each has an `id` the provider makes and keeps until the resource is replaced: the file's
full path, the string, or a random UUID. Only the provider makes `id`, `result` and
`stdout`, so setting one in the configuration is refused.

Each resource is held to its schema. A name the schema does not have, a required one
left out, or a value of another type is refused where it is written. A number or a bool
where a string is wanted becomes its text: `5` is `"5"`, `1.50` is `"1.5"`. A string
where a number or a bool is wanted is read as one when it spells one: `"8"` is `8`,
`"true"` is `true`, and `"8 MB"` is refused. Nothing else is converted. The plan, the
provider and the state all see the converted value.

A data source reads something that already exists. `data "local_file" "f" { path = "x" }`
reads a file, and `data.local_file.f.content` is what it holds. A data source has a schema
of its own, apart from a resource of the same type, and its block is held to it as a
resource's is, before anything is read. A read that returns a value not known, or a name
the schema does not have, stops the run as a bug in the provider.

## How a run goes

1. Each resource in state is read back from its provider, so a change made by hand shows
   up. A resource found gone is made again, or forgotten if the configuration dropped
   it. `plan` and `apply` take `--refresh=false` to skip this and plan against the state
   alone. An apply writes what was read, even when nothing else changes. A saved plan is
   applied as it was made, so `apply <plan>` reads nothing and refuses the flag. A read
   that returns a value not known, or a name the schema does not have, stops the run as
   a bug in the provider.
2. The parser turns `main.clay` and every module it names into a tree, with the file,
   line and column on every node.
3. The graph builder links each resource, variable and output to what it reads, and
   sorts them so nothing runs before what it needs. A cycle or a reference to nothing
   stops here.
4. Each value is resolved in that order and held to the type its schema names. The
   provider checks it and plans what the resource will hold: a value it computes is
   known after apply once anything changes, unless it can work it out sooner, as
   `local_file` does its id from an absolute path. It also says which changes replace
   the resource. A plan that changes a value the configuration sets is refused. The
   planner compares each plan with the state and lists the actions: create, update,
   replace, delete, or nothing.
5. `apply` runs the actions in order, deletes in reverse order, and writes the state
   after each one, so a failure leaves everything before it on disk. Before each
   create, update or replace, the provider plans it again with what is known by then.
   A value the plan showed that comes out different, or a replace where the plan showed
   an update, stops the run before anything changes. What the provider returns is held
   to that plan. The state is written to a temporary file and renamed, a backup is kept,
   and a lock file stops two runs at once.

An error says where it was written:

```
Planning failed: var.tags is a list and cannot be joined into a string

  on modules/app/main.clay line 4, in resource "local_file" "a":

  4:   content = "tags: ${var.tags}"
                          ^

  in module.app
```

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
