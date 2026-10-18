# Language

What a `.clay` file means. `GRAMMAR.md` has how it is written.

## Values and types

A file is a list of blocks. Values are strings, numbers, booleans, lists, maps and `null`,
and a string can read other values with `${...}`. A string over many lines is a heredoc:
`<<-EOT`, the lines, then `EOT`.

Every value carries its type. A written list is a tuple, `["a", 1]` is
`tuple([string, number])`, and a written map is an object; a value read from a resource or
a data source has the type its schema names, and keeps it through variables, module inputs
and outputs. An attribute set to `null` is left out, as if it were not written, so a
required one is refused. `null` inside a list, a map or an object stays there, since it is
a value of every type: an object's attribute that its type does not make optional must be
named, and may be `null`.

A variable may name its type, `type = set(string)`, and takes what it is given as that
type. An output may name its type the same way, and gives its value as that type, so its
caller knows it before a plan. An attribute of an object type can be optional, with a
default: `object({ port = optional(number, 80) })`.

## Count and for_each

A resource with `count = 3` makes three instances, `type.name[0]` to `type.name[2]`, and
`count.index` inside the block is the index of the one being made. Another value reads
one of them: `local_file.logs[0].content`. Adding `count` to a resource that exists moves
it to `[0]` instead of making it again. With `for_each = { web = 80, api = 8080 }`, or a
list of strings, it makes one instance for each key, `type.name["web"]`, and `each.key`
and `each.value` inside the block are the key and value of the one being made.

A module call takes `count` too: with `count = 3`, `module.web[0]` to `module.web[2]` are
each a whole copy of the module, and `count.index` in the call's inputs is the index of
the copy. Adding `count` to a module that exists moves what is in it to `module.web[0]` in
the same way. A module call takes `for_each` too, `module.web["eu"]`, with `each.key` and
`each.value` in its inputs.

A `for_each` map needs its keys at plan time, not its values: `{ a = random_string.s.id }`
plans `["a"]` with `each.value` unknown.

## References

`var.name`, `local.name`, `local_file.a.content`, `module.m.out`, `module.web[0].out`, and
`random_string.s.id` for what the provider assigned. A reference reads into a map or a
list with `.key`, `["key"]` and `[0]`: `var.tags.env`, `var.names[0]`. A bracket may hold
a reference too, read where it is written: `var.names[count.index]`.

A resource named with no attribute is an object of all its attributes: `local_file.a`, or
one instance as `local_file.logs[0]` and `local_file.f["key"]`. With `count`,
`local_file.logs` alone is the list of every instance, and with `for_each`, `local_file.f`
is a map of them by key, so `for_each = local_file.f` makes one instance for each.

A resource to be created or changed is read at plan time as its provider plans it, so
`random_string.s.length` is known, and so is `local_file.a.id` when only its content
changes; what only the apply makes, such as the id of a new resource or
`random_string.s.result`, is unknown and shown as such. It still has its type, so one of
a type the attribute does not take is refused at plan. A name the schema does not have is
refused at plan; one it has that nothing sets reads as `null`.

A list or a map is known as far as its items are: `{ a = random_string.s.id, b = "x" }`
plans as `{"a":(known after apply),"b":"x"}`. A set keeps the members it knows while one
is unknown; that one may turn out the same as another, so how many members it holds is
known only after apply. Taken as a list, such a set is unknown as a whole until then,
since it has no order yet.

Reaching inside a module (`module.m.local_file.a`) is not allowed; a module speaks through
its outputs. A module named with no output is an object of all its outputs: `module.m`, or
one instance as `module.web[0]`. With `count` or `for_each`, `module.web` alone is a list
or a map of them, as for a resource. Each output takes one type across the instances, as
`tolist` gives one; where an output names no type, values that cannot share one, such as a
string in one instance and a list in another, are refused at plan.

`path.module` is the directory of the module it is written in, relative to the root, so
`"${path.module}/index.html"` names a file next to the module.

## Locals

A local is a value with a name: `locals { name = "${var.prefix}-x" }` is read as
`local.name`. It may read anything, another local among them, and is worked out once for
each instance of its module, after what it reads. It names no type and has the one its
value has. Only its own module reads it. A file may hold several `locals` blocks; a name
set twice is refused.

## Functions

A function is called by its name: `count = length(var.names)`, or `"${length(var.names)}"`
inside a string. `length` counts the items of a list, a set or a map, and the characters
of a string. `tolist` and `toset` turn a list, a tuple or a set into a list or a set, so
`tolist(pool.p.members)[0]` reads a member of a set; `toset` keeps each member once. Their
items take one type: a number or a boolean beside a string becomes its text, and a number
beside a boolean, or objects with other names, are refused.

## For

A for expression makes a list from a collection: `[for n in var.names : "app-${n}"]`. With
two names it reads a key too: a list's index, a map's key, or a set's member again, as in
`[for i, n in var.names : "${i}-${n}"]`. With braces and `=>` it makes an object instead:
`{for n in var.names : n => "app-${n}"}`. A key two items give is refused, unless `...`
after the value groups them.

## Sensitive values

An output with `sensitive = true` is hidden where it would be printed: `plan`, `apply` and
`clay output` show `(sensitive value)` in its place, and a plan that puts the flag on or
takes it off hides the value too. One that does not fit its `type` is refused without its
value. `clay output --json` gives the value with `"sensitive": true`. The state and a plan
file hold it unencrypted.

A variable with `sensitive = true` is sensitive wherever it is read, its default and the
value a module call gives it. `sensitive(x)` marks a value sensitive as a whole,
`nonsensitive(x)` takes every mark off it, and `issensitive(x)` is true when any part of it
is sensitive. A value given to a sensitive variable that does not fit its `type` is refused
without quoting it in the message.

A module's sensitive output stays sensitive wherever its caller takes it: through a local,
a variable, a string, a function and a `for`. It is followed part by part, so in
`{ name = "app", password = module.db.password }` only `password` is sensitive. A set is
sensitive as a whole when one member is, since its order and size give the member away.
`length` of a list is not sensitive when only an item is. A `for` not known until apply is
sensitive as a whole when its collection or a key is, and its `length` with it. When only
its body reads a sensitive value, each item is sensitive and its `length` is not.

A root output that holds a sensitive value and does not say `sensitive = true` is refused,
at `validate`, `plan` and `apply`. A `for_each` with a sensitive key is refused, since a
key shows in an address, and so is a sensitive `count`, since a plan shows how many
instances it makes. `for_each = { primary = module.db.password }` is taken: only
`each.value` is sensitive. An error raised while a value is worked out does not quote a
sensitive one: `enabled: (sensitive value) is not a boolean, which is "true" or "false"`.

A resource attribute given a sensitive value is sensitive where it is read back, so
`local_file.conf.content` in a root output needs `sensitive = true` too. The state keeps
which parts of each resource are sensitive beside its values. `plan`, its "Changed outside
Clay" and `clay state show` print `(sensitive value)` for each sensitive part, on both
sides of a change where either side is sensitive, and name each attribute whose sensitive
parts change: `content: will be marked sensitive`.

An error about a resource names a sensitive attribute and quotes neither value, and what a
provider says when its validate or plan fails on a configuration holding a sensitive value
is not shown, only that it failed. A data source given a sensitive value gives it back
sensitive at the same parts, `data.local_file.f.path` for a sensitive `path`. A value a
provider works out from a sensitive one is not sensitive, unless its schema marks the
attribute sensitive: that attribute is sensitive whoever sets it, and null too.

A provider's own message from a create, update, delete or read is shown as it words it,
since an I/O error with its path is what a user needs to fix the run. A provider that
quotes a sensitive value in that message shows it plainly.

## Schemas

Each resource is held to its schema. A name the schema does not have, a required one left
out, or a value of another type is refused where it is written. A number or a bool where a
string is wanted becomes its text: `5` is `"5"`, `1.50` is `"1.5"`. A string where a
number or a bool is wanted is read as one when it spells one: `"8"` is `8`, `"true"` is
`true`, and `"8 MB"` is refused. A list and a set are taken as one another, and so are a
map and an object. Nothing else is converted. The plan, the provider and the state all see
the converted value.

A schema may call a list a set: its order is not a change, and a member written twice is
held once. A plan shows a change to a set as the members it loses and gains.

State and a plan hold each root output as its value and its type, the one it names or the
one its value has: `{ "value": ["a", "b"], "type": { "kind": "set", ... } }`. A set output
changes by its members too. An output whose value stays and whose type changes is a
change, shown by the two types: `m = ["a","b"] (list(string) -> set(string))`.

## Lifecycle

`lifecycle { prevent_destroy = true }` in a resource refuses a plan that replaces it. A
plan that deletes it is refused too, with the block gone or an instance dropped by `count`
or `for_each`, since the state keeps what the last apply found in the block. A replace
goes by the block as it is written now, so `false` allows it, and so does removing the
block when an attribute that forces a replace changes in the same plan. To delete a
resource that prevents it, set `prevent_destroy = false`, apply, then delete it. The flag
alone changing is an update that writes the state and calls no provider.

`lifecycle { create_before_destroy = true }` makes a replace create the new object first.
The old one stays in state as a deposed object, and is destroyed once everything that read
it is updated, at the end of the apply with the deletes. A create that fails leaves the
old object whole; a destroy that fails leaves it deposed, and the next plan destroys it. A
resource that a resource with the flag reads gets it too, through any others in between,
since an order made of one without the other could not hold. A module's resource is one
block for all the instances of the module, so a flag there reaches each of them.
`prevent_destroy` still refuses the replace.

`lifecycle { ignore_changes = [content] }` keeps a change to those attributes out of the
plan. The configuration is read as if the attribute still held what the state has, before
the provider plans, so an ignored attribute that forces a replace forces none, and a
replace for another reason keeps the old value. A path may reach into a map or a list,
`tags["Name"]` or `items[0]`, but not into a set; `all` ignores every attribute. A create
ignores nothing, there being nothing yet. A change made outside Clay still shows under
"Changed outside Clay"; the refresh reads it, and the plan then has nothing to undo.

State may hold deposed objects, apart from `resources`, by the address they were left by:
earlier objects of a resource that a replace did not destroy. A plan destroys them as a
delete of their own, `- local_file.db (deposed object) will be destroyed`, whether or not
the resource is still in the configuration, and `prevent_destroy` does not hold it back,
since the current object is not touched. They go one at a time, oldest first, each gone
from state once its provider has destroyed it, so a failure leaves the rest for the next
run. `clay state mv` and `rm` take them along.

## Data sources

A data source reads something that already exists. `data "local_file" "f" { path = "x" }`
reads a file, and `data.local_file.f.content` is what it holds. `data.local_file.f` alone
is an object of every attribute it has. With `count = 2` it is read twice, as
`data.local_file.f[0]` and `data.local_file.f[1]`, each with its own `count.index`, and
`data.local_file.f` alone is the list of them. With `for_each` it is read once for each
key, as `data.local_file.f["key"]` with its own `each.key` and `each.value`, and
`data.local_file.f` alone is the map of them.

A data source has a schema of its own, apart from a resource of the same type, and its
block is held to it as a resource's is, before anything is read. A read that returns a
value not known, or a name the schema does not have, stops the run as a bug in the
provider. A data source is read once for each instance of its module, in its turn among
the resources.

It is read at plan, unless what it reads changes in the apply: a resource the plan
creates or changes, read directly or through a variable, a local or a module output. Then
the plan shows `<= data.local_file.f will be read during apply`, or a line for each index
or key with `count` or `for_each`, `<= data.local_file.f[0] ...`. What it reads is
`(known after apply)`, and the apply reads it after those resources. In a module called
with `count` or `for_each` each instance waits on its own: one whose resources stay as
they are is read at plan while another waits.

The plan carries what it read, so the apply reads none of those again and a `count` that
reads one makes the instances the plan showed. A `count` or `for_each` that reads one the
apply reads is refused at plan, since the plan cannot show its instances. A plan file
holds them unencrypted, a secret a data source read among them.

## Saved plans

A saved plan carries the configuration it was made from, the state it was planned
against, what the refresh read, what each data source read at plan gave and which ones the
apply reads. `apply` runs that configuration, not the one on disk now, against what the
refresh read, and refuses the plan if the state has changed since.

On every apply, a value the plan showed as known that now comes out otherwise stops the
run before that resource is touched. An output is held to the plan the same way, as soon
as what it reads has run, and one the plan left as it was is held to the state. A provider
that makes a resource other than the plan showed stops the run too: what it made is kept
in state, and the error lists each value that differs.
