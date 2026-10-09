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

A file is a list of blocks. Values are strings, numbers, booleans, lists, maps and `null`,
and a string can read other values with `${...}`. A string over many lines is a heredoc:
`<<-EOT`, the lines, then `EOT`.

Every value carries its type. A written list is a tuple, `["a", 1]` is
`tuple([string, number])`, and a written map is an object; a value read from a resource or a
data source has the type its schema names, and keeps it through variables, module inputs
and outputs. An attribute set to `null` is left out, as if it were not written, so a
required one is refused. `null` inside a list or a map stays there. A variable may name its
type, `type = set(string)`, and takes what it is given as that type. An output may name its
type the same way, and gives its value as that type, so its caller knows it before a plan.
An attribute of an object type can be optional, with a default:
`object({ port = optional(number, 80) })`.

| Block                            | Does                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `resource "type" "name" { ... }` | Something the provider creates, updates and destroys           |
| `variable "name" { default = }`  | A value the file takes; a module gets it from its caller       |
| `locals { name = }`              | Values the file works out once and reads by name               |
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

An output with `sensitive = true` is hidden where it would be printed: `plan`, `apply`
and `clay output` show `<sensitive>` in its place, and a plan that puts the flag on or
takes it off hides the value too. One that does not fit its `type` is refused without
its value. `clay output --json` gives the value with `"sensitive": true`. The state and
a plan file hold it unencrypted.

A module's sensitive output stays sensitive wherever its caller takes it: through a
local, a variable, a string, a function and a `for`. It is followed part by part, so in
`{ name = "app", password = module.db.password }` only `password` is sensitive. A set is
sensitive as a whole when one member is, since its order and size give the member away.
`length` of a list is not sensitive when only an item is. A `for` not known until apply
is sensitive as a whole when any part of it is, its `length` too. A root output that holds a
sensitive value and does not say `sensitive = true` is refused, at `validate`, `plan`
and `apply`. A `for_each` with a sensitive key is refused, since a key shows in an
address, and so is a sensitive `count`, since a plan shows how many instances it makes.
`for_each = { primary = module.db.password }` is taken: only `each.value` is sensitive.
An error raised while a value is worked out does not quote a sensitive one:
`enabled: (sensitive value) is not a boolean, which is "true" or "false"`. One thing is
still open: a resource attribute given a sensitive value shows it in the plan and in an
error about the resource, a provider's own among them, and is not sensitive where it is
read back, a `for_each` among them.

A local is a value with a name: `locals { name = "${var.prefix}-x" }` is read as
`local.name`. It may read anything, another local among them, and is worked out once for
each instance of its module, after what it reads. It names no type and has the one its
value has. Only its own module reads it. A file may hold several `locals` blocks; a name
set twice is refused.

References: `var.name`, `local.name`, `local_file.a.content`, `module.m.out`,
`module.web[0].out`, and `random_string.s.id` for what the provider assigned. A reference reads into a map or a
list with `.key`, `["key"]` and `[0]`: `var.tags.env`, `var.names[0]`. A resource named
with no attribute is an object of all its attributes: `local_file.a`, or one instance as
`local_file.logs[0]` and `local_file.f["key"]`. With `count`, `local_file.logs` alone is
the list of every instance, and with `for_each`, `local_file.f` is a map of them by key, so
`for_each = local_file.f` makes one instance for each. A resource to be
created or changed is read at plan time as its provider plans it, so `random_string.s.length`
is known, and so is `local_file.a.id` when only its content changes; what only the apply
makes, such as the id of a new resource or `random_string.s.result`, is unknown and shown
as such. It still has its type, so one of a type the attribute does not take is refused
at plan. A name the schema does not have is refused at plan; one it has that nothing sets
reads as `null`. A list or a map is known as far as its items are:
`{ a = random_string.s.id, b = "x" }` plans as `{"a":(known after apply),"b":"x"}`.
A set keeps the members it knows while one is unknown; that one may turn out the same as
another, so how many members it holds is known only after apply. Taken as a list, such a
set is unknown as a whole until then, since it has no order yet.
Reaching inside a module (`module.m.local_file.a`) is not allowed; a module speaks
through its outputs. A module named with no output is an object of all its outputs:
`module.m`, or one instance as `module.web[0]`. With `count` or `for_each`, `module.web`
alone is a list or a map of them, as for a resource. Each output takes one type across
the instances, as `tolist` gives one; where an output names no type, values that cannot
share one, such as a string in one instance and a list in another, are refused at plan.
`path.module` is the directory of the module it is written in,
relative to the root, so `"${path.module}/index.html"` names a file next to the module.

A function is called by its name: `count = length(var.names)`, or `"${length(var.names)}"`
inside a string. `length` counts the items of a list, a set or a map, and the characters
of a string. `tolist` and `toset` turn a list, a tuple or a set into a list or a set, so
`tolist(pool.p.members)[0]` reads a member of a set; `toset` keeps each member once. Their
items take one type: a number or a boolean beside a string becomes its text, and a number
beside a boolean, or objects with other names, are refused.

A for expression makes a list from a collection: `[for n in var.names : "app-${n}"]`.
With two names it reads a key too: a list's index, a map's key, or a set's member again,
as in `[for i, n in var.names : "${i}-${n}"]`.
With braces and `=>` it makes an object instead: `{for n in var.names : n => "app-${n}"}`.
A key two items give is refused, unless `...` after the value groups them.

`docs/GRAMMAR.md` has the full grammar.

## Commands

| Command                  | Does                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `clay init`              | Creates an empty state file, or says so if one is already there                                           |
| `clay validate`          | Resolves references and checks values with the schema and the provider; reads no state and no data source |
| `clay plan [--out file]` | Shows what `apply` would do; `--out` saves the plan with its configuration                                |
| `clay apply [plan] [-y]` | Runs the plan it shows, or a saved one; `-y` skips the question                                           |
| `clay output [--json]`   | Prints the root outputs from the last apply; `--json` gives each with its type, a sensitive one too       |
| `clay state list`        | Lists the resources in state                                                                              |
| `clay state show <addr>` | Prints one resource as it is in state                                                                     |
| `clay state mv <a> <b>`  | Renames a resource in state, so the next plan does not recreate it                                        |
| `clay state rm <addr>`   | Forgets a resource without destroying it                                                                  |

A saved plan carries the configuration it was made from, the state it was planned
against, what the refresh read, what each data source read at plan gave and which ones
the apply reads. `apply` runs that configuration, not the one on disk now, against what
the refresh read, and refuses the plan if the state has changed since.
On every apply, a value the plan showed as known that now comes out otherwise stops the
run before that resource is touched. An output is held to the plan the same way, as soon
as what it reads has run, and one the plan left as it was is held to the state. A provider that makes a resource other than the plan
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
`stdout`, so setting one in the configuration is refused; `null` sets none.

Each resource is held to its schema. A name the schema does not have, a required one
left out, or a value of another type is refused where it is written. A number or a bool
where a string is wanted becomes its text: `5` is `"5"`, `1.50` is `"1.5"`. A string
where a number or a bool is wanted is read as one when it spells one: `"8"` is `8`,
`"true"` is `true`, and `"8 MB"` is refused. A list and a set are taken as one another,
and so are a map and an object. Nothing else is converted. The plan, the provider and the
state all see the converted value. A schema may call a list a set: its order is not a
change, and a member written twice is held once. A plan shows a change to a set as the
members it loses and gains.

State and a plan hold each root output as its value and its type, the one it names or the
one its value has: `{ "value": ["a", "b"], "type": { "kind": "set", ... } }`. A set
output changes by its members too. An output whose value stays and whose type changes is
a change, shown by the two types: `m = ["a","b"] (list(string) -> set(string))`.

A data source reads something that already exists. `data "local_file" "f" { path = "x" }`
reads a file, and `data.local_file.f.content` is what it holds. `data.local_file.f` alone
is an object of every attribute it has. With `count = 2` it is read twice, as
`data.local_file.f[0]` and `data.local_file.f[1]`, each with its own `count.index`, and
`data.local_file.f` alone is the list of them. With `for_each` it is read once for each
key, as `data.local_file.f["key"]` with its own `each.key` and `each.value`, and
`data.local_file.f` alone is the map of them. A data source has a schema
of its own, apart from a resource of the same type, and its block is held to it as a
resource's is, before anything is read. A read that returns a value not known, or a name
the schema does not have, stops the run as a bug in the provider. A data source is read
once for each instance of its module, in its turn among the resources. It is read at plan,
unless what it reads changes in the apply: a resource the plan creates or changes, read
directly or through a variable, a local or a module output. Then the plan shows
`<= data.local_file.f will be read during apply`, or a line for each index or key with
`count` or `for_each`, `<= data.local_file.f[0] ...`. What it reads is `(known after apply)`, and the apply reads
it after those resources. In a module called with `count` or
`for_each` each instance waits on its own: one whose resources stay as they are is read at
plan while another waits. The plan carries what it read, so the apply reads none of those
again and a `count` that reads one makes the instances the plan showed. A `count` or
`for_each` that reads one the apply reads is refused at plan, since the plan cannot show
its instances. A plan file holds them unencrypted, a secret a data source read among them.

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
5. `apply` runs the actions in order, deletes in reverse order, and writes the state
   after each one, so a failure leaves everything before it on disk. Before each
   create, update or replace, the provider plans it again with what is known by then.
   A value the plan showed that comes out different, or a replace where the plan showed
   an update, stops the run before anything changes. What the provider returns is held
   to that plan. The state is written to a temporary file and renamed, a backup is kept,
   and a lock file stops two runs at once.

An error says where it was written:

```
Planning failed: var.tags is a tuple and cannot be joined into a string

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
