# Clay

An infrastructure-as-code engine in TypeScript. You describe resources in a `main.clay`
file; Clay compares it with what it created last time, shows what would change, and
applies it. Terraform is the reference for the problems it has solved well, not a
specification to copy.

It ships with one provider, `local`, whose resources live on the machine that runs it.

## Try it

Node 22.13 or newer.

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
string can read other values with `${...}`.

| Block                            | Does                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `resource "type" "name" { ... }` | Something the provider creates, updates and destroys           |
| `variable "name" { default = }`  | A value the file takes; a module gets it from its caller       |
| `output "name" { value = }`      | A value the file gives back; a module's caller reads it        |
| `module "name" { source = }`     | Another directory with its own `main.clay`, called with inputs |

References: `var.name`, `local_file.a.content`, `module.m.out`, and `random_string.s.id`
for what the provider assigned. A value read from a resource that has not been created
yet is unknown at plan time and shown as such. Reaching inside a module
(`module.m.local_file.a`) is not allowed; a module speaks through its outputs.

`docs/GRAMMAR.md` has the full grammar.

## Commands

| Command                  | Does                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `clay init`              | Creates an empty state file, or says so if one is already there                        |
| `clay validate`          | Parses, resolves references and has the provider check the values; reads no state file |
| `clay plan [--out file]` | Shows what `apply` would do; `--out` saves the plan with its configuration             |
| `clay apply [plan] [-y]` | Runs the plan it shows, or a saved one; `-y` skips the question                        |
| `clay output [--json]`   | Prints the root outputs from the last apply                                            |
| `clay state list`        | Lists the resources in state                                                           |
| `clay state show <addr>` | Prints one resource as it is in state                                                  |
| `clay state mv <a> <b>`  | Renames a resource in state, so the next plan does not recreate it                     |
| `clay state rm <addr>`   | Forgets a resource without destroying it                                               |

A saved plan carries the configuration it was made from and the state serial it was
planned against. `apply` runs that configuration, not what is on disk now, and refuses
the plan if the state has changed since.

## Resources

| Type            | Attributes                                                                              |
| --------------- | --------------------------------------------------------------------------------------- |
| `local_file`    | `path` (replaces on change), `content`                                                  |
| `random_string` | `length`, `special`, both replace on change; the string is its `id`                     |
| `null_resource` | `triggers`, a map; does nothing, and another resource can read its `id` to run after it |
| `command_exec`  | `command`, `cwd`; runs on create and on every update                                    |

## How a run goes

1. The parser turns `main.clay` and every module it names into a tree, with the file,
   line and column on every node.
2. The graph builder links each resource, variable and output to what it reads, and
   sorts them so nothing runs before what it needs. A cycle or a reference to nothing
   stops here.
3. Each value is resolved in that order; the planner compares it with the state and
   lists the actions: create, update, replace, delete, or nothing.
4. `apply` runs the actions in order, deletes in reverse order, and writes the state
   after each one, so a failure leaves everything before it on disk. The state is written
   to a temporary file and renamed, a backup is kept, and a lock file stops two runs at
   once.

An error says where it was written:

```
Planning failed: "tags: ${var.tags}" cannot be joined into a string: var.tags is a list

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
