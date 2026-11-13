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

## depends_on

`depends_on = [local_file.a]` makes a resource, a data source, a module call or an output
wait for `local_file.a` though it reads nothing of it. It may name a resource, a data
source, a variable, a local, a module or a module's output, each as a whole:
`local_file.a`, never `local_file.a[0]`, since the order is kept between blocks, not
instances. A variable, a local or an output waits for what it reads. `module.m` waits for
every block in the module and in the modules it calls, even one no output reads.
`module.m.out` waits only for what that output reads, and needs no index where the module
has `count` or `for_each`.

In a module call, `depends_on` makes every block in the module wait. In an output, it
makes whatever reads the output wait too.

A wait counts as a reference does. The apply makes `local_file.a` first and destroys it
last, and the state keeps the order for a destroy after the block is gone, with one entry
for each block an object read, not for each instance. A data source that waits for a
resource the plan creates or changes is read during apply. A wait that closes a cycle is
refused.

## Locals

A local is a value with a name: `locals { name = "${var.prefix}-x" }` is read as
`local.name`. It may read anything, another local among them, and is worked out once for
each instance of its module, after what it reads. It names no type and has the one its
value has. Only its own module reads it. A file may hold several `locals` blocks; a name
set twice is refused.

## Validation

A `validation` block gives a rule the value of a variable must meet, and the message to
give where it does not:

```
variable "port" {
  type = number
  validation {
    condition     = var.port > 0 && var.port < 65536
    error_message = "port is ${var.port}; it must be 1 to 65535"
  }
}
```

The rules are checked in order at plan, after the type, for each instance of the module.
A value they refuse is refused where it is given, at the default or at the module call,
with the first failing rule's message: `variable "port": port is 70000; it must be 1 to
65535`. A rule that reads a part of the value not known until the apply is checked at
the apply. A message that holds a sensitive value is not shown, but the value is still
refused.

A rule may read anything else in the module that declares the variable: other variables,
locals, resources and data sources. For a module input, that is the module, not the call.
The variable then waits for what its rules read, and a rule that reads what reads the
variable is refused as a cycle. A rule that reads a resource not created yet is checked at
the apply, after the resource is.

## Functions

A function is called by its name: `count = length(var.names)`, or `"${length(var.names)}"`
inside a string. `length` counts the items of a list, a set or a map, and the characters
of a string. `tolist` and `toset` turn a list, a tuple or a set into a list or a set, so
`tolist(pool.p.members)[0]` reads a member of a set; `toset` keeps each member once. Their
items take one type: a number or a boolean beside a string becomes its text, and a number
beside a boolean, or objects with other names, are refused. `upper` and `lower` change the
case of a string, and `join(", ", var.names)` makes one string of the items of a list.
`alltrue([for p in var.ports : p > 0])` is true when every item of a list is, and
`anytrue` when one is; a null item is refused. One false item decides `alltrue`, and one
true item `anytrue`, before the rest are known.
`merge(local.common, { env = "prod" })` gives every key of both, the later one winning,
and `lookup(var.sizes, var.env, "small")` reads a key, with a default where it is not.
`format("%s-%02d", var.name, count.index + 1)` writes `web-01`, `web-02` and so on.

## Operators

`==` and `!=` compare two values: `var.env == "prod"`. A list and a tuple with the same
items are equal, and so are a map and an object with the same keys. `null` written as it
is compares with anything. Two values of types that can never be equal are refused where
the operator is, even before they are known: a number and a string, a set and a list, or
lists whose items are such types, even when both are empty. Terraform says `false` there.

`&&`, `||` and `!` take booleans; anything else, `null` among them, is refused.
`cond ? a : b` gives `a` when the condition is true and `b` when it is false: `count =
var.env == "prod" ? 3 : 1`. Its two results join into one type, as `tolist`'s items do,
whichever the condition picks, and a pair that cannot is refused. A value of no type, such
as a variable that names none, has its type only once it is read.

A known condition decides which result is read, and a known left side of `&&` or `||`
that decides the answer leaves the right side unread. So `var.x == null ? "none" :
var.x.name` reads `.name` only when there is an x, and `var.on ? local_file.f[0].path :
null` takes a count of 0. The side not read is still checked for its type, so a mistake
in it is refused. A condition not known until apply leaves the result unknown, and both
sides are read.

The result is sensitive when what decided it is: the condition or the result it picks, or
any sensitive part of what `==` compares. Against `null`, only a value sensitive as a
whole makes it so, since the answer tells only whether the value is there. A sensitive
condition, or a sensitive left side of `&&` or `||`, can still be learned from whether
the run fails: an error in the side it picks is shown like any other.

Where the condition, or a side of `&&` or `||`, is not known until apply, the result is
sensitive at plan only where it would be whichever way the apply goes: `cond ?
sensitive(a) : b` is not, `cond ? sensitive(a) : sensitive(b)` is, and of two objects only
the parts both mark are, where both hold them. Where each marks a different part, the
result is still sensitive somewhere: `issensitive` of it is true, though neither part read
alone is sensitive. A `for` over it is too where the body keeps the item's mark, and so is
a `merge` where no later argument may give a key it holds. A mark on every item of a
collection not known yet says nothing for certain, since the collection may come out
empty. A mark that depends on the way waits for the apply, so `issensitive` gives the same
answer at plan and apply, and a root output that may hold such a value is refused at plan.
Terraform marks the result of such a condition where either side is marked.

`+`, `-`, `*`, `/` and `%` work on numbers, and `-var.n` negates one:
`count = var.zones * 2`. Numbers stay exact, so `0.1 + 0.2` is `0.3`; a result past a
thousand places either side of the point is refused. A quotient keeps 34 significant
digits, rounded half to even, so `1 / 3` is `0.3333333333333333333333333333333333` and
`10 / 4` is `2.5`, but `2 / 3 * 3` is `2.0000000000000000000000000000000001`. `%` gives
what is left after whole times, with the sign of the left side: `-7 % 3` is `-1`. Either
one by zero is refused. Terraform gives infinity for `1 / 0` and the left side for
`1 % 0`.

`<`, `<=`, `>` and `>=` order two numbers. A string that spells a number is read as one,
as a schema reads it: `"8" + 1` is `9`, and `"8 MB" + 1` is refused. Anything else,
`null` among them, is refused, and a boolean or a list by its type before any value is
known. A side not known until apply leaves the result unknown, and a sensitive side makes
it sensitive.

## For

A for expression makes a list from a collection: `[for n in var.names : "app-${n}"]`. With
two names it reads a key too: a list's index, a map's key, or a set's member again, as in
`[for i, n in var.names : "${i}-${n}"]`. With braces and `=>` it makes an object instead:
`{for n in var.names : n => "app-${n}"}`. A key two items give is refused, unless `...`
after the value groups them. An `if` after the value keeps only the items it is true for:
`{ for k, v in var.servers : k => v if v.on }`. An item it leaves out is read by type
only, like the result a condition does not pick. A sensitive `if` makes what the for gives
sensitive, and like a sensitive condition it can be learned from whether the run fails.

`[*]` is a shorter way to write a for over a list, a tuple or a set: `var.servers[*].port` is
`[for s in var.servers : s.port]`, and `local_file.f[*].path` reads each instance a
`count` makes. Every step after `[*]` reads into each item, so `var.servers[*].disks[0]`
is the first disk of each; `(var.servers[*].port)[0]` is the first port. A map, an object
or null is refused, where Terraform wraps a value that is not a list in one.

## Sensitive values

An output with `sensitive = true` is hidden where it would be printed: `plan`, `apply` and
`clay output` show `(sensitive value)` in its place, and a plan that puts the flag on or
takes it off hides the value too. One that does not fit its `type` is refused without its
value. `clay output --json` gives the value with `"sensitive": true`. The state and a plan
file hold it unencrypted.

A variable with `sensitive = true` is sensitive wherever it is read, its default and the
value a module call gives it. `sensitive(x)` marks a value sensitive as a whole,
`nonsensitive(x)` takes every mark off it, and `issensitive(x)` is true when any part of it
is sensitive. While a part is not known yet and no mark says so, `issensitive` waits for
the apply. A value given to a sensitive variable that does not fit its `type` is refused
without quoting it in the message.

A module's sensitive output stays sensitive wherever its caller takes it: through a local,
a variable, a string, a function and a `for`. It is followed part by part, so in
`{ name = "app", password = module.db.password }` only `password` is sensitive. A set is
sensitive as a whole when one member is, since its order and size give the member away.
`length` of a list is not sensitive when only an item is. A `for` not known until apply is
sensitive as a whole when its collection, a key or an `if` is, and its `length` with it.
Otherwise each item has the marks every possible body has, and its `length` is not
sensitive. An item kept for certain has its own marks at its key, or at its place where no
item before it may be dropped, and its sensitive key makes the whole sensitive; grouped,
a key has the marks every value that may join it has, and such an item has its place in
the group where no item before it may join. A `for` over such a value keeps the marks at
the keys and places that value has for certain, in the order it goes over them: the
places of a tuple, an object's keys sorted.

Other values chosen at apply keep, at plan, the marks every choice has. `lookup` with a
key not known yet has the marks every value and the default share, and is sensitive as a
whole where the key or the whole map is; with a key a value not known yet marks, it has
that key's marks. An index not known yet gives the marks every item has along the rest of
the reference, or the whole where an index is sensitive. `merge` with an argument not
known yet gives each key the marks every value has, and a key some argument gives for
certain the marks shared by that argument and every later one not known yet.

A root output that holds a sensitive value and does not say `sensitive = true` is refused,
at `validate`, `plan` and `apply`. So is one that may hold one by what the apply finds,
such as `cond ? sensitive(a) : b` with `cond` not known at plan: the plan refuses it, so
the apply does not fail on it after it made the resources. `validate` reads no state, so
it leaves such a value to the plan. A value whose sensitivity waits for the apply is not
known at plan either, so `count = cond || sensitive(true) ? 1 : 2` is refused as not
known. A `for_each` with a sensitive key is refused, since a key shows in
an address, and so is a sensitive `count`, since a plan shows how many instances it makes.
`for_each = { primary = module.db.password }` is taken: only `each.value` is sensitive. An
error raised while a value is worked out does not quote a sensitive one: `enabled:
(sensitive value) is not a boolean, which is "true" or "false"`. It names the value's
type, a list or null, since the configuration sets that: `&& takes a boolean, not a
string`. It does not name its keys, its size or what it holds.

A resource attribute given a sensitive value is sensitive where it is read back, so
`local_file.conf.content` in a root output needs `sensitive = true` too. The state keeps
which parts of each resource are sensitive beside its values. `plan`, its "Changed outside
Clay" and `clay state show` print `(sensitive value)` for each sensitive part, on both
sides of a change where either side is sensitive, and name each attribute whose sensitive
parts change: `content: will be marked sensitive`.

An error about a resource names a sensitive attribute and quotes neither value. What a
provider says when a call fails is not shown where a value given to it is sensitive, only
that it failed: `command_exec failed to create; a value given to it is sensitive, so the
reason is not shown`. That holds for every call, from validate and plan to create, update,
destroy, read and identify, since a provider may quote what it was given, as `exec` quotes
the whole command.

A data source given a sensitive value gives it back sensitive at the same parts,
`data.local_file.f.path` for a sensitive `path`. A value a provider works out from a
sensitive one is not sensitive, unless its schema marks the attribute sensitive: that
attribute is sensitive whoever sets it, and null too. A schema can also mark a computed
attribute sensitive with others it is made from: `command_exec.stdout` is sensitive as a
whole where `command` or `cwd` holds a sensitive part, so `echo ${var.token}` keeps it
hidden, and plain otherwise. `local_file.id`, the file's full path, is sensitive where
`path` is.

Where nothing given is sensitive, a provider's own message is shown as it words it, since
an I/O error with its path is what a user needs to fix the run.

## Schemas

Each resource is held to its schema. A name the schema does not have, a required one left
out, or a value of another type is refused where it is written. A number or a bool where a
string is wanted becomes its text: `5` is `"5"`, `1.50` is `"1.5"`. A string where a
number or a bool is wanted is read as one when it spells one: `"8"` is `8`, `"true"` is
`true`, and `"8 MB"` is refused. A list and a set are taken as one another, and so are a
map and an object. Nothing else is converted. The plan, the provider and the state all see
the converted value.

A schema may give an attribute a default, which the plan holds where the configuration
leaves it out. Writing the default out, or taking it out again, changes nothing:
`special = false` on a `random_string` that left it out plans no change. Taking out
another value goes back to the default.

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
run. A move, by a `moved` block or `clay state mv`, takes them along, and `clay state rm`
removes them with the resource.

## Provisioners

A `provisioner "local-exec" { command = "..." }` block in a resource runs its command
once the resource's object is made: after a create, and after the create of a replace.
An update runs none. The command runs through the shell, in the directory Clay runs in or
in `working_dir`, which a relative path reads from there. `environment = { NAME = "value" }`
sets variables over Clay's own environment; one set to null keeps the one Clay has.
Several run in the order written.

Its values are read at apply, after the object is made, and what they read the resource
waits for, as it does for its own attributes. `self` is the object it runs on: `self.path`,
`self.id`, or `self` for the whole object, each instance its own under `count` or
`for_each`. A provisioner cannot name its own resource, which would wait for itself, and
`self` anywhere else is refused where it is written. A command that fails stops the apply for
that resource and the provisioners after it. The object stays in state, marked tainted:
the next plan replaces it, `tainted, so it is replaced`, and its provisioners run again.
`ignore_changes` keeps nothing of a tainted object.

`on_failure = continue` goes on past a command that fails: apply prints why, the object
is not tainted, and the provisioners after it still run. `on_failure = fail` is the
default. Either is a word written without quotes. A value refused at apply, before the
command runs, still stops the apply.

Apply prints the command, then each line it prints on stdout and stderr as it comes:
`null_resource.n (local-exec): hello`. Lines from stdout and stderr keep their order within
each stream, not between the two. `quiet = true` leaves out the command, and still prints
its lines. Where a value given to the command is sensitive, apply prints one line that says
so in place of all of them, and the error does not say why it failed.

`validate` refuses a type no provisioner has, an argument it does not take, and a
`command` that is missing, null, empty or not a string, an empty `working_dir`, and an
`environment` with a name that is empty or holds `=`, or a NUL character in a name or
value, each where it is written. A `working_dir` that is not a directory fails at apply,
before the command runs. A plan that makes an object checks the values of its
provisioners it knows, such as a key a map does not have, with `self` as the object the
plan makes; one only the apply knows is checked then, before the command runs. A plan
that makes no object, an update or no change, runs no provisioner and checks none of
their values.

`when = destroy` runs a provisioner before the object is destroyed instead: when its block
is gone, and before a replace destroys the old object, the one a `create_before_destroy`
replace leaves behind too. `when = create` is the default.
Its values are read once the object is made, and again by each apply that keeps it, and
state keeps them, so it runs once the block is gone too. A command changed in the
configuration runs from the next apply; a plan that changes only that shows an update,
`the provisioners run before it is destroyed will change`. It reads only `self`,
`count.index` and `each.key`; anything else is refused where it is written. A command
that fails stops the destroy, and the object stays in state, not tainted, for the next
apply to try again. `on_failure = continue` destroys it anyway. None run on a tainted
object, which a failed step left half made.

## Moved

A `moved` block says a resource was renamed, so the plan moves its state to the new
address instead of destroying it and creating it again:

```
moved {
  from = local_file.old
  to   = local_file.new
}
```

With no key on either side, every instance moves, each to the same key. With a key on
one side, one instance moves, and a side with no key is the instance with none:
`from = local_file.a` and `to = local_file.a["web"]` keeps a resource that gains
`for_each`. The plan shows each move, `> local_file.new will be moved from local_file.old`,
or beside the change it makes, and the apply moves the state before any action. A `to`
the configuration does not declare is destroyed there.

The addresses are read in the module the block is in, and the block moves in each
instance of that module. A block in the root may name what is inside a module,
`module.web.local_file.a`, and so move a resource into a module or out of one. Such a
block and one inside the module are read together: `module.web[0].local_file.a` in the
root names the same object as `local_file.a` in `web`, so the two may chain or clash.

Keep the block after the apply: a state that does not hold `from` moves nothing, so the
block can stay for whoever applies the configuration later. Blocks chain, `a` to `b` and
`b` to `c`, and the plan moves `a` to `c` in one step. A move of one instance runs before a
move of its whole resource.

Refused, at the block:

- `from` still declared: the block would move the state away from it
- the state already holding `to`, or for a whole resource any instance of it, since one
  of the two objects would be lost; remove the one to forget with `clay state rm`
- one address moved to two places, or two addresses to one
- blocks that move in a circle

A `to` of another type is refused at `to`, since its provider could not take the object.

A block may move a module call or a module instance instead, with every resource in it and
every module under it:

```
moved {
  from = module.old
  to   = module.new
}
```

The keys work as for a resource: `module.old` to `module.new` moves each instance to the
same key, and `module.web` to `module.web["eu"]` keeps a module that gains `for_each`. A
module moves only where the state holds nothing in its new module, or for a whole call in
any instance of it. A module `from` still declared is refused even with nothing in it. A
change of a module's keys and a move inside that module both apply.

An implicit move, from adding or removing `count`, follows a `moved` block: the block
moves first, then the count moves what it moved.

## Import

An `import` block takes over an object that exists but is not in state, so the plan does
not create it again over what is there:

```
import {
  to = local_file.a
  id = "/srv/app.conf"
}
```

`to` needs a `resource` block of its own. The plan asks the provider for the object `id`
names, reads it as a refresh does, and plans the block against it. It shows the import,
`<- local_file.a will be imported from "/srv/app.conf"`, or beside the change it brings,
`~ local_file.a will be updated, imported from "/srv/app.conf"`. The apply puts the object
in state, after any move and before any action, and then makes the change. The object
takes the marks and dependencies of its block.

What an id is depends on the type. For `local_file` it is the path, and a relative one is
read where Clay runs. `random_string`, `null_resource` and `command_exec` exist only in
state, so there is nothing to take over, and they cannot be imported.

The id may read any value known at plan: a variable, a local, a data source, or what
another resource is planned to hold. It is read as the plan reaches `to`, and `to` waits
for what it reads, as it waits for its own values:

```
import {
  to = local_file.a
  id = "${var.dir}/app.conf"
}
```

The plan shows the id, so it must be a string that is not empty, known at plan and not
sensitive. A saved plan imports by the id it showed, even if what the id reads has changed
since.

`for_each` imports one object for each item, as a resource's `for_each` makes one
instance for each: a map, or a list or a set of strings, where each string is both the key
and the value. The key of `to` reads `each`, and so may the id:

```
import {
  for_each = { web = "/srv/web.conf", db = "/srv/db.conf" }
  to       = local_file.conf[each.key]
  id       = each.value
}
```

A key of `to` reads only `each`, so the resource is known before any value is. It must
be a string or a whole number from 0, known at plan and not sensitive, since it shows in
the address. The items of a for_each with no key in `to` all go to that one address.
Each plan reads `for_each` and the key, even once the state holds every object, since
they say which addresses the block names; the id is read only for an object to import.

`to` may name a resource inside a module, through each module call on the way, as
`module.app.local_file.a`, or `module.app[0].local_file.a` where the call has `count`. Any
key of `to` may read `each`, a module call's as well as the resource's:

```
import {
  for_each = { web = "/srv/web.conf", db = "/srv/db.conf" }
  to       = module.site[each.key].local_file.conf
  id       = each.value
}
```

The block stays in the root module; a module that others call cannot import.

Keep the block after the apply: a state that holds `to` imports nothing, whatever the id.
Nor does one that holds what adding or removing `count` moves to `to`, as `local_file.a`
for `local_file.a[0]`; the plan moves it instead.
To take over another object at the same address, remove the one in state first with
`clay state rm`.

Refused at the id: a value only an apply makes, a sensitive value, a value that is not a
string, and an empty string. Refused at a key of `to`: a value only an apply makes, a
sensitive value, and a value that is not a string or a whole number from 0. Refused at
`for_each`: what a resource's `for_each` refuses. `validate` refuses what it can already
tell of the id, and asks no provider.

Refused, at the block:

- a block in a module another module calls; only the root module imports
- `to` with no `resource` block, or through a module call that is not declared
- `to` with a key that does not fit the resource or a module call on the way: a number for
  `count`, a string for `for_each`, none for neither
- `to` an instance the configuration does not make, as `[1]` with `count = 1`, in a
  resource or a module call
- a type its provider cannot import
- an id that finds nothing, or something the type is not, as a directory for a file
- an object another address in the plan holds too, as two blocks for one file
- two imports to one address, from two blocks or two items of one `for_each`

A saved plan imports only where the configuration still has an import block for it. A
block with `for_each` covers every instance of its resource, in every instance of its
module, since only the plan reads which.

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

## Backend

A `clay` block in the root module names where the state lives:

```
clay {
  backend "local" {
    path = "state/prod.json"
  }
}
```

Every value in the block is a string, a number, `true` or `false` written out, since the
state has to be found before anything has a value.

`local` keeps the state in a file. `path` is relative to the root, or absolute. It cannot be
empty or end in `.clay`. With no block, or no `path`, the state is `clay.state.json` next to
the configuration. The lock, the backup and the journal sit beside the file it names.

`http` keeps the state on a server, in the protocol Terraform's `http` backend uses:

```
clay {
  backend "http" {
    address      = "https://state.example.com/prod"
    lock_address = "https://state.example.com/prod/lock"
  }
}
```

- A `GET` of `address` reads the state. A 404, a 204 or an empty body is no state yet.
- `update_method` (`POST` by default) writes it whole, with a `Content-MD5` header and
  the lock's id as `?ID=`. 200, 201 and 204 count as written.
- `lock_method` (`LOCK`) sends the lock to `lock_address` as JSON. A 409 or 423 means
  another run holds it, and its body names that run.
- `unlock_method` (`UNLOCK`) sends the same body to `unlock_address`, which is
  `lock_address` where none is given. A lock or an unlock counts on 200, 201 or 204.
  `clay force-unlock` first sends a lock to learn which one the server holds, then sends
  back the body the server named. A lock it is given where none was held, it releases.

No redirect is followed. Followed, a `POST` would go on as a `GET`, and its 200 would
count as written. An address names where the server answers.

`address` and `lock_address` are required, so the state is never written without the lock.
An address is `http` or `https`. It cannot hold a user or a password, since every message
that names the state would print them.

Over `https`, Clay trusts the CAs Node brings, those in `NODE_EXTRA_CA_CERTS`, and those
the system trusts: the macOS keychain, the Windows store, or `/etc/ssl` on Linux.

`ca_certificate` names a PEM file of CAs, relative to the root or absolute. Clay then
trusts those alone, in place of the ones above. The file is read again on each command, so
a new CA needs no `clay init`. Every block in it must be a certificate Clay can read.

A server that asks who the client is gets the certificate in `CLAY_HTTP_CLIENT_CERTIFICATE`
and its key in `CLAY_HTTP_CLIENT_KEY`, both PEM text. Both are set, or neither. The key is
the first certificate's, and not encrypted, since Clay asks for no passphrase. The block
refuses `client_certificate` and `client_private_key`, and `init` does not remember them.
`ca_certificate` with no `https` address is refused. The client certificate goes only to
`https` addresses, so the variables can stay set for a backend on plain `http`.

A request that gets no answer, a 429 or a 5xx other than 501 is tried again. A failed TLS
handshake is not: a certificate Clay does not trust, a server that asks for a client
certificate it is not shown, or a server that speaks no TLS fails the same way on every
try. A server that refuses the client certificate it is shown may close the connection
without saying why, which Clay cannot tell from a lost one, and tries again. Each setting
is a whole number:

- `retry_max` (2, up to 100): the tries after the first.
- `retry_wait_min` (1) and `retry_wait_max` (30), up to 3600: the first wait in
  seconds, doubled after each try, and the longest. A `Retry-After` on the answer sets
  the wait; one longer than `retry_wait_max` ends the tries.
- `timeout` (30, 1 to 3600): the seconds one try may take, its body read whole. A try
  that takes longer got no answer.

A write sent twice writes the same state. A lock whose answer was lost is known on the next
try, as the server names this run's own lock. A failed lock or unlock after more than one
try says an earlier one may have taken or released the lock already.

Basic auth comes from the environment: `CLAY_HTTP_USERNAME` and `CLAY_HTTP_PASSWORD`, sent
with every request, the lock's too. The block refuses `username` and `password`, since the
configuration is checked in, and `init` does not remember them. A variable set empty counts
as unset. A password needs a username; a username alone is sent with an empty password. A
401 names the two variables, and no message prints their values. A password or a username
the variables cannot hold stops every command on an `http` backend, `validate` too.
They go to every address the block names, over `http` as well as `https`.

`s3` keeps the state as one object in an S3 bucket:

```
clay {
  backend "s3" {
    bucket = "acme-state"
    key    = "prod/clay.state.json"
    region = "eu-west-1"
  }
}
```

- `bucket` and `key` are required. A bucket name holds no `/`. A key does not start or
  end with `/`, and holds no `//`. It is at most 1019 bytes in UTF-8, so the lock's name
  (the key plus `.lock`) fits in S3's limit of 1024 bytes.
- `region` is required, or `AWS_REGION` or `AWS_DEFAULT_REGION` in the environment. A
  region from the environment is read again on each command, and `init` does not
  remember it.
- `endpoint` names a server other than AWS that speaks S3, such as RustFS, by an `http`
  or `https` URL. `use_path_style = true` puts the bucket in the path instead of the host
  name, as most such servers want.

The lock is a second object, `<key>.lock`, written only where none is
(`If-None-Match: *`). When another run holds it, the error names that run and the
`clay force-unlock` command with its id, or the object to remove where the lock names no
run. To release it, Clay reads the lock, checks its id, and deletes it only if it is
still the version it read (`If-Match`). AWS and RustFS keep to `If-Match`. A server that
ignores it, or sends no ETag, deletes the lock anyway, so a lock another run took between
the read and the delete is lost.

Credentials come from where the AWS CLI finds them: `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN`), a profile in `~/.aws`, or the role of
the machine. The block refuses `access_key`, `secret_key` and `token`. Clay needs
`s3:GetObject` and `s3:PutObject` on the key and the lock, `s3:DeleteObject` on the lock,
and `s3:ListBucket` on the bucket: without it, AWS answers 403 for an object that does not
exist yet, and `init` cannot tell it from a refusal.

A request that gets no answer, a 5xx or a throttling error is sent up to three times in
all, and one try may take 30 seconds. S3 keeps no journal, so each write sends the state
whole.

`azure` keeps the state as one blob in an Azure Storage container:

```
clay {
  backend "azure" {
    storage_account_name = "acmestate"
    container_name       = "state"
    key                  = "prod/clay.state.json"
  }
}
```

- `storage_account_name`, `container_name` and `key` are required. An account name is 3
  to 24 lowercase letters and digits. A container name is 3 to 63 lowercase letters,
  digits and single hyphens between them. A key is at most 1019 characters, so the lock's
  name (the key plus `.lock`) fits in Azure's limit of 1024. It does not start or end with
  `/`, does not end with `.`, and holds no `//`, no `.` part and no `..` part.
- `endpoint` names a server other than Azure that speaks the Blob API, such as Azurite,
  or another Azure cloud, by an `http` or `https` URL. Azurite takes the account in its
  path: `http://127.0.0.1:10000/devstoreaccount1`. Without it, the account's own address
  is used: `https://<account>.blob.core.windows.net`.

The lock is a second blob, `<key>.lock`, written only where none is
(`If-None-Match: *`). When another run holds it, the error names that run and the
`clay force-unlock` command with its id, or the blob to delete where the lock names no
run. To release it, Clay reads the lock, checks its id, and deletes it only if it is
still the version it read (`If-Match`). Azure and Azurite keep to both headers.

Credentials come from the environment, by the names the `az` CLI uses:
`AZURE_STORAGE_KEY` holds an account key, or `AZURE_STORAGE_SAS_TOKEN` a SAS token,
with or without its leading `?`. Setting both stops every command on the backend. The block
refuses `access_key` and `sas_token`. A SAS token needs read, create, write and delete on
the container.

With neither set, Clay signs in with Entra ID. This works on an account where shared keys
are turned off. It tries, in this order:

1. A service principal: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`,
   or `AZURE_CLIENT_CERTIFICATE_PATH` in place of the secret
2. AKS workload identity
3. A managed identity, on an Azure VM, App Service or container
4. `az login`, then `Connect-AzAccount` in PowerShell, then `azd auth login`

`AZURE_TOKEN_CREDENTIALS` limits it to one of these, such as `AzureCliCredential` or
`ManagedIdentityCredential`. The identity needs a data role on the container or the
account, such as Storage Blob Data Contributor. A role like Owner or Contributor is not
enough. An Entra ID token is sent over `https` only, so an `http` endpoint needs a key or
a SAS token.

In GitHub Actions, sign in with `azure/login` before Clay runs. Clay then uses the
`az login` it leaves:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: azure/login@v3
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
  - run: clay apply --yes
```

The token this sign-in gives a service principal lasts one hour by default, so a job
that runs longer after the step fails.

A request that gets no answer, a 429 or a 5xx other than 501 is sent up to three times in
all. The wait before the second try is one second, and it doubles after each try. One try
may take 30 seconds. Azure keeps no journal here, so each write sends the state whole.

A root module holds one backend across its files, and a module none. Every command reads
the block, so a syntax error in a root file stops `output` and `state` too. A saved plan
runs on the backend in the files it carries.

`clay init` takes the block and remembers every setting of it, defaults filled in, in
`.clay/backend.json`. That file belongs to one checkout and stays out of version control. It
refuses a directory that does not exist, and makes none. Every command but `validate` then
refuses a configuration that names another place than `init` took, a removed block too, or
the same place with another setting, and says to run `clay init`. With no
block and no record the state is the default file, and no `init` is needed.

`clay init` takes the lock while it writes the first state. Where the block names another
place and the old one holds a state, `init` takes the lock of both, asks, and copies the
state there with its serial and what its `.journal` holds. `--yes` approves without
asking; with the input closed it stops and names `--yes`. Ctrl-C at the question releases
both locks and changes nothing. The old state is left as it was.
`init` refuses when the new place holds another state, before it asks. Where it holds the
same one, as an `init` stopped after the copy leaves it, `init` takes it as it is. A
`.journal` with no state beside it is refused, and `init` names it to remove. Two
addresses on one server that share a lock address are moved under that one lock.

## Saved plans

A saved plan carries the configuration it was made from, the state it was planned
against, what the refresh read, what each data source read at plan gave and which ones the
apply reads. `apply` runs that configuration, not the one on disk now, against what the
refresh read, and refuses the plan if the state has changed since. Each resource is given
what its block in that configuration says. A field of the wrong kind in the file is
refused before anything runs.

On every apply, a value the plan showed as known that now comes out otherwise stops the
run before that resource is touched. An output is held to the plan the same way, as soon
as what it reads has run, and one the plan left as it was is held to the state. A provider
that makes a resource other than the plan showed stops the run too: what it made is kept
in state, and the error lists each value that differs.
