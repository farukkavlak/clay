# Grammar

What the parser in `packages/parser` accepts. A configuration is one file, `main.clay`,
in a directory; a module is another directory with its own `main.clay`.

## Tokens

| Token             | Pattern                               | Notes                                                                   |
| ----------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `IDENTIFIER`      | `[A-Za-z_][A-Za-z0-9_-]*`             | Block kinds, names, reference parts; not `true`, `false`, `null`        |
| `OQUOTE`          | `"`                                   | Opens a string                                                          |
| `QUOTED_LIT`      | Text up to `"` or `${`                | Escapes as written, read below; `\"` and `$${` are text; no line breaks |
| `TEMPLATE_INTERP` | `${`                                  | Inside a string                                                         |
| `TEMPLATE_END`    | `}`                                   | Closes a `${`                                                           |
| `CQUOTE`          | `"`                                   | Closes a string                                                         |
| `OHEREDOC`        | `<<NAME` or `<<-NAME`, a line break   | Opens a heredoc                                                         |
| `STRING_LIT`      | A heredoc's text, a line at a time    | No escapes                                                              |
| `CHEREDOC`        | A line holding only `NAME`            | Closes a heredoc; spaces or tabs may come around the name               |
| `NUMBER`          | `[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?` | No sign; `007` is `7`; at most 1000 places either side of the point     |
| `MINUS`           | `-`                                   | Only before a number                                                    |
| `BOOLEAN`         | `true`, `false`                       |                                                                         |
| `NULL`            | `null`                                |                                                                         |
| `LBRACE`          | `{`                                   |                                                                         |
| `RBRACE`          | `}`                                   |                                                                         |
| `LBRACKET`        | `[`                                   |                                                                         |
| `RBRACKET`        | `]`                                   |                                                                         |
| `LPAREN`          | `(`                                   | Opens a call's arguments                                                |
| `RPAREN`          | `)`                                   |                                                                         |
| `COMMA`           | `,`                                   |                                                                         |
| `COLON`           | `:`                                   | Only in a for expression                                                |
| `FAT_ARROW`       | `=>`                                  | Only in a for expression that makes an object                           |
| `ELLIPSIS`        | `...`                                 | Only in a for expression that makes an object                           |
| `ASSIGN`          | `=`                                   |                                                                         |
| `DOT`             | `.`                                   |                                                                         |
| `EOF`             |                                       | Ends every token stream                                                 |

Whitespace and comments are skipped. A comment runs from `#` or
`//` to the end of the line. Every token carries the file, line and column it starts at. A
line break written as CRLF is read as LF, so no value changes with how a checkout wrote
the file's line breaks.

Inside quotes the lexer reads text until `"` or `${`. A `${` reads tokens as outside
quotes until its `}`: a quote there opens a string of its own, so `"${var.tags["a.b"]}"`
reads a key, and a comment there is refused. A string still open at the end of its line
is refused where it opens; write `\n` for a line break, or use a heredoc. When a `${` is
open too, the first open `${` is named: a `}` left out opens a string at the quote meant
to close, and that looks the same as a key not closed on its line, so the message names
both. Inside a `${` a line break is whitespace, and a `{` opens a map, so the `}` that
closes the map does not close the `${`. A heredoc is read the same
way, a line at a time, until its closing line; one still open at the end is refused where
it opens.

There are no keywords. `resource`, `data`, `variable`, `locals`, `output` and `module`
start a block only at the top level; anywhere else they are ordinary identifiers, so
`data = "x"` inside a block is an attribute. `for` right after `[` or `{`, and `in` after
its names, start a for expression; `[for.a.id]` is still a list holding a reference, and
`{ for = 1 }` a map with a key named `for`.

## Blocks

A file is a sequence of blocks. Two blocks of the same kind and name in one file are an
error. A resource is named by its type and name together, so `resource "a" "x"` and
`resource "b" "x"` are different resources.

```
resource "type" "name" { attributes }
data "type" "name" { attributes }
variable "name" { attributes }
locals { attributes }
output "name" { value = value }
module "name" { attributes }
```

A `type` and a `name` are written as strings, and each has to spell an `IDENTIFIER`, since
an address joins them with `.` and a reference reads them back. A `type` cannot be `var`,
`local`, `data`, `module`, `count`, `each` or `path`, the words a reference reads as
something other than a type. A variable cannot be named `source`, since a module call reads that as
the module's path, or `count` or `for_each`, which a module call keeps for itself.

`attributes` is zero or more `name = value` pairs, in any order, without separators, and
no name twice.
`output` must have `value`, and may have `type` and `sensitive`. `sensitive` is `true` or
`false` as written, never another value or a reference.

`locals` takes no name of its own. Each attribute is a local of the module, read as
`local.name`. A file may hold several `locals` blocks, and they are read as one: a name
set twice, in one block or in two, is refused at the second. A local may share its name
with a variable or an output.

What the engine reads from each:

| Block      | Reads                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `resource` | `count` or `for_each`, read by the engine; every other attribute goes to the provider                                        |
| `data`     | `count` or `for_each`, read by the engine; every other attribute goes to the provider                                        |
| `variable` | `default`, a constant: no reference or function call; `type`, read below; another attribute is refused where it is written   |
| `locals`   | every attribute, as a value of any kind; it may read anything a resource's attribute may, another local among them           |
| `output`   | `value`; `type`, read below; `sensitive`, which hides the value of a root output wherever it is printed                      |
| `module`   | `source`, a literal string naming a directory relative to the file; `count` or `for_each`; every other attribute is an input |

A resource, a data source or a module with both `count` and `for_each` is refused where
it is written.

A module's `source` starts with `./` or `../`. Anything else, a registry address or an
absolute path, is refused where it is written.

## Values

```
value   = string | heredoc | [ "-" ] NUMBER | BOOLEAN | NULL | reference | call | list | for | map
string  = OQUOTE { QUOTED_LIT | TEMPLATE_INTERP ( reference | call ) TEMPLATE_END } CQUOTE
heredoc = OHEREDOC { STRING_LIT | TEMPLATE_INTERP ( reference | call ) TEMPLATE_END } CHEREDOC
list    = "[" [ value { "," value } [ "," ] ] "]"
map     = "{" { key "=" value [ "," ] } "}"
key     = IDENTIFIER | string
```

A string reads `\n`, `\r`, `\t`, `\"` and `\\`, a character by number as `\uNNNN` or
`\UNNNNNNNN`, and `$${` as the text `${`. Any other escape is refused where it is written.
An escape is read in a string's text, not inside a `${...}`; a quoted map key reads them
too, and a block label never holds one.

A minus may stand apart from its number: `- 5` is `-5`. A name keeps its dash, so
`a-1` is one identifier, not `a` minus `1`.

A list needs a comma between items and may end with one. A map does not need commas.
A map key may be a bare identifier or a quoted string, and appears once; a block kind is
a fine identifier, `true`, `false` and `null` are not, and neither is `__proto__`, for an
attribute name either. A block is not named `true`, `false` or `null`, since a reference to
it would read as the value.

### Types

Every value has a type. A string, a number and a boolean have theirs; a list is a tuple,
with a type for each item, and a map is an object, with a type for each key. `null` has no
type until it is used where one is named. A value read from a resource or a data source
has the type its schema names, `set(string)` or `list(number)`, and keeps it through
variables, module inputs and outputs.

Where a schema names a type, a value is converted to it: a tuple, a list and a set to one
another, an object and a map to one another, a number or a boolean to its text, and a
string to the number or boolean it spells. Anything else is refused where it is written:
`content is a tuple, where local_file takes a string`. An attribute set to `null` is left
out, as if it were not written; inside a list or a map, `null` stays.

A value not known until apply still has its type, so one of a type the attribute does not
take is refused at plan. A set with a member not known yet keeps the members it knows;
taken as a list, it is not known as a whole until apply, since it has no order yet.

### Variable types

```
type = "string" | "number" | "bool" | "any"
     | ( "list" | "set" | "map" ) "(" type ")"
     | "tuple" "(" "[" [ type { "," type } [ "," ] ] "]" ")"
     | "object" "(" "{" { IDENTIFIER "=" attribute [ "," ] } "}" ")"
attribute = type | "optional" "(" type [ "," value ] ")"
```

The words are bare: `type = string`, not `type = "string"`. A word that names no type, or
`(` after one that holds none, is refused where it is written.

A variable with a type takes every value it is given as that type, converted as a schema
converts it: `["b", "a", "a"]` given to `set(string)` is `["a", "b"]`. A value it cannot
take is refused where it is written, a module input in the call and a default in its own
block. A default is checked even where a module call gives a value in its place. A module
input with no reference in it is checked even where `count` or `for_each` makes no
instance. An object given an attribute its type does not name is refused, since that is
most often a name misspelled. `null` is taken, as a null of the type.

Every attribute an object type names is required, unless `optional(...)` is around its
type. One left out is `null`, or the default written after its type:
`object({ name = string, port = optional(number, 80) })` given `{ name = "a" }` is
`{ name = "a", port = 80 }`. An attribute given `null` takes the default too. A default is
a constant, held to its attribute's type when the configuration is loaded, and the
defaults inside it are filled in as well. `optional` is written only as the type of an
object's attribute.

`any` takes a value as it is. In a list, a set or a map, the items are joined into one
type as `tolist` joins them: `[1, "x"]` given to `list(any)` is `["1", "x"]`. A variable
without a type takes any value as it is.

A value not known until apply has the variable's type at plan, so one of a type the
variable can never take is refused there; what it holds is checked once the apply knows
it. `any` keeps the type of what it is given.

### References

```
reference = IDENTIFIER { step }
step      = "." IDENTIFIER | "[" ( NUMBER | string ) "]"
```

A bare reference is a value on its own: `path = var.dir`. Inside a string it is written
`${...}`. The first part says what it reads:

| First part | Reads                                                | Example                     |
| ---------- | ---------------------------------------------------- | --------------------------- |
| `var`      | A variable or input of the same module               | `var.name`                  |
| `local`    | A local of the same module                           | `local.name`                |
| `data`     | A data source, or an attribute it read               | `data.local_file.f.content` |
| `module`   | An output of a module called in the same file        | `module.app.url`            |
| `count`    | The index of the instance being made                 | `count.index`               |
| `each`     | The key of the instance being made, or its value     | `each.key`, `each.value`    |
| `path`     | The directory of a module, relative to the root      | `path.module`, `path.root`  |
| anything   | An attribute of the resource with that type and name | `local_file.a.content`      |

A resource's `id` is an attribute like any other, one its provider makes. Each local resource
keeps its `id` until it is replaced.

A resource named with no attribute is the whole instance: an object that holds every
attribute of its schema, with `null` for one nothing sets. `local_file.a` reads a resource
with no `count` or `for_each`, `local_file.logs[0]` one instance by its index and
`local_file.f["key"]` one by its key. A resource with `count` or `for_each` named with no
index or key is every instance: a list by index under `count`, a map by key under
`for_each`. A key is written in brackets, so under `for_each`
`local_file.f.content` has no key and is refused: a name after a dot there is never a key.

A data source is read the same way. `data.local_file.f` is an object of every attribute
of its schema, with `null` for one nothing sets. With `count`, `data.local_file.f[0]` is
one instance and `data.local_file.f` alone is the list of them; with `for_each`,
`data.local_file.f["key"]` is one and `data.local_file.f` alone the map of them by key.

`path.module` is the directory of the module it is written in, relative to the root: `.`
at the root, `web` in a module called with `source = "./web"`. In a call's inputs it is the
directory of the module that calls. `path.root` is `.`. A relative path is read from where
`clay` runs, which is the root, so `"${path.module}/index.html"` names a file next to the
module. Any other name after `path.` is refused where it is written.

After what it names, a reference may read into the value: `.name` or `["key"]` reads a
key of a map, and `[0]` an item of a list, counted from 0. So `local_file.a.tags.env`,
`var.names[0]` and `module.app.info["url"]` each read one value. An index is written in
digits; a quoted key reads escapes as a map key does. A key the map does not have, an
index past the end of the list, or a step into a string, number, bool or null is refused
where the reference is written. So is an index into a set, whose members have no order.
A value not known until apply is read into at apply. An attribute of a resource or a
data source that its schema has and nothing sets reads as `null`; a name the schema does
not have is refused.

The parts before that name what is read, so each is a name even when it is quoted:
`var["region"]` is `var.region`, and `module["a.module.b"]` is refused.

A module is read through its outputs, so `module.app.local_file.a` names an output
called `local_file`, and is refused when the module has none. A module called with count
or for_each is read one instance at a time: `module.app[0].url`, `module.app["eu"].url`.
The key is written in brackets there too, so `module.app.eu.url` is refused.

### Functions

```
call = IDENTIFIER "(" [ value { "," value } [ "," ] ] ")" { step }
```

A name with `(` after it calls a function; any other name starts a reference, so a
resource type may be spelled as a function is. An argument is any value, a call too. The
steps after the `)` read into what the function gives, as a reference's do.

| Function        | Gives                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `length(value)` | How many items a list, a tuple or a set holds, keys a map or an object, or characters a string |
| `tolist(value)` | A list, a tuple or a set as a list of the one type its items share                             |
| `toset(value)`  | A list, a tuple or a set as a set of the one type its items share, each member once            |

A character is what a reader counts as one: a letter with its accent, or an emoji made of
several code points, is one. A number, a boolean or `null` is refused where the argument
is written.

A list or a map has its length while an item in it is not known until apply. A set with
a member not known yet does not, since that member may turn out to be one the set already
holds; its length is known at apply, and so is the length of a value not known at all.

`tolist` and `toset` find the one type every item can be taken as. Items of one type keep
it. A number or a boolean beside a string becomes its text; a number and a boolean alone
are refused, since they have no text in common. Tuples of one length stay tuples, position
by position; other lists are a list of what their items share, and a set among them makes
it a set. Objects with the same names share each attribute's type; objects with other
names are refused, where Terraform would make them a map. An object beside a map is a
map. A `null` item takes the type the others have. Anything else is refused where the argument is written, and so is an argument that is
not a list, a tuple or a set. `null` gives `null`.

`toset(["b", "a", "b"])` holds `"a"` and `"b"`: a set holds each member once, in one order.
`tolist` of a set gives its members in that order. A set with a member not known yet has
no order, so `tolist` of it is not known until apply; `toset` of a list with an item not
known yet keeps the members it knows.

A name no function has, or a call with another number of arguments than the function
takes, is refused where the call is written, in a module nothing is made of too.

### For

```
for = "[" "for" names "in" value ":" value "]"
    | "{" "for" names "in" value ":" value "=>" value [ "..." ] "}"
names = IDENTIFIER [ "," IDENTIFIER ]
```

`[for n in var.names : "app-${n}"]` reads the body after the `:` once for each item of
the collection, and gives a tuple of what each comes to. With one name, the name is the
item. With two, the first is its key and the second its value:

| Collection         | Key                 | Value      |
| ------------------ | ------------------- | ---------- |
| A list or a tuple  | The index, a number | The item   |
| A set              | The member          | The member |
| A map or an object | The key, a string   | Its value  |

A map or an object is read in the order of its keys. A string, a number, a boolean or
`null` is refused where the collection is written, at plan too when the value is known
only after apply but its type is known.

A name the for gives is read in its body only, with steps after it as a reference's:
`[for f in var.files : f.path]`. In the collection, and after the `]`, the same name is a
reference again. A name cannot be one a reference starts with, `var`, `local`, `data`,
`module`, `count`, `each` or `path`, nor the type of a resource in the same file, nor one a
for around it gives; the key and the value need names of their own. Terraform lets such a
name hide what it spells; Clay refuses it where it is written.

An item not known until apply is not known in what the for gives either, and the rest is
known. A collection not known at all leaves the whole for to the apply, and so does a set
with a member not known yet: that member may sort before the others and move every item.
The key and the value are still read once at plan, with an item not known yet, so a
reference that cannot be read is refused then, and a sensitive value in either makes the
whole for sensitive.
A for over a constant may be a variable's default.

`{for n in var.names : n => "app-${n}"}` makes an object: the key before `=>` and the
value after it are read once for each item. Each value keeps its own type. A key is a
string; a number or a boolean becomes its text, and anything else, `null` too, is
refused where the key is written, at plan too when the key is known only after apply but
its type is known. `__proto__` is refused as a key, as in a map.

A key two items give is refused where the key is written. With `...` after the value,
`{for f in var.files : f.dir => f.name...}`, the items of one key are grouped instead:
the key holds a tuple of their values, in the order of the items.

A value not known until apply is not known in the object either, under a key the plan
shows. A key not known until apply leaves the whole for to the apply, since the keys say
what the object holds; a mistake in another item is still refused at plan.

### Count

A resource with `count = n` makes `n` instances, addressed `type.name[0]` to
`type.name[n-1]`. `n` is a whole number from 0, known when planning: a literal, a
variable, a value a resource already has, or one the configuration sets on a resource to
be created or changed. One that reads a value only an apply makes, such as an id, is
refused where it is written. So is a sensitive one, since a plan shows how many
instances it makes.

Inside the block, `count.index` is the index of the instance being made. Anywhere else,
and in `count` itself, it is refused where it is written.

A reference names one instance: `local_file.logs[0].content`. On a resource with count,
`local_file.logs.content` is refused, and so is an index past `n - 1`; on one without,
an index is refused. Reading an instance that stays as it is gives its value, even when
another instance of the same block changes.

Adding `count` to a resource that exists moves it to `type.name[0]`, and taking `count`
off moves `type.name[0]` back to `type.name` and destroys the other instances. A move
changes only where state keeps the resource; a plan shows it, and any change to the
resource runs with it. With `count = 0` nothing takes its place, so it is destroyed.

### Count on a module

A module call with `count = n` makes `n` instances of the module, addressed
`module.name[0]` to `module.name[n-1]`, and everything in the module is made once in each:
`module.web[1].local_file.page`. `n` is read in the module that calls it, the way a
resource's count is. A call in a module with count makes its instances in each instance of
that module.

In the call's inputs, `count.index` is the index of the instance being made. Inside the
module it is refused where it is written: the module is written once for every way it may
be called, so it takes the index as an input.

An output is read from one instance: `module.web[0].url`. On a call with count,
`module.web.url` is refused, and so is an index past `n - 1`; on one without, an index is
refused.

A data source in a module called with count or for_each, or in a module that one calls,
is read once for each instance of its module, and a plan names it by the instance:
`module.web[0].data.local_file.f`, or `module.web[0].data.local_file.f[1]` and
`module.web[0].data.local_file.f["key"]` with a `count` or a `for_each` of its own. Each instance of the module waits for the apply on its own.

Adding `count` to a module that exists moves what is in it to `module.name[0]`, and
taking `count` off moves `module.name[0]` back and destroys the other instances, as for a
resource. Each resource the configuration still has is moved on its own; one it no longer
has is destroyed where state keeps it. A resource that gains count with its module moves
in one step, `module.web.local_file.a` to `module.web[0].local_file.a[0]`. When state
keeps it in two places it may have been, the plan is refused where the resource is
written, since taking either would destroy the other; `clay state mv` says which.

### For each

A resource with `for_each` makes one instance for each key, addressed `type.name["key"]`.
Over a map, the keys are the map's and each instance is given the value under its key.
Over a list of strings, each string is a key and its own value. A string twice in the
list is refused, and so is anything other than a map or a list of strings. Its keys are
known when planning: a map's values may wait for the apply, and `each.value` is then
unknown, but a list item or a whole value only an apply makes is refused.
A sensitive key is refused, since a key shows in an address: a value sensitive as a
whole, or a list or a set with a sensitive item. A map's values may be sensitive, and
`each.value` is then sensitive too.
The instances are planned in the order of their keys. An empty map or list makes none, so
any that exist are destroyed.

Inside the block, `each.key` is the key of the instance being made and `each.value` its
value, which a reference can read into: `each.value.port`. Anywhere else but a module
call with for_each, and in `for_each` itself, they are refused where they are written.

A reference names one instance by its key, in brackets: `local_file.site["web"].content`.
A name after a dot there is never a key, so `local_file.site.web.content` and
`local_file.site.content` are refused as naming no instance. An index, and a key
`for_each` does not give, are refused where they are written.

Adding `for_each` to a resource, or taking it off, moves nothing: no key stands for the
resource the way `[0]` does for a count. `clay state mv 'type.name' 'type.name["key"]'`
keeps it.

### For each on a module

A module call with `for_each` makes one instance of the module for each key, addressed
`module.name["key"]`, the way a resource's for_each does, over a map or a list of strings.
It is read in the module that calls it, and a call in a module with count or for_each
makes its instances in each instance of that module.

In the call's inputs, `each.key` is the key of the instance being made and `each.value`
its value. Inside the module they are refused where they are written; the module takes
them as inputs.

An output is read from one instance by its key, in brackets: `module.web["eu"].url`. A
name after a dot there is never a key, so `module.web.eu.url` and `module.web.url` are
refused where they are written, and so are an index and a key `for_each` does not give. A data source in the module
is read once for each instance, as it is under count.

Adding `for_each` to a module that exists, or taking it off, moves nothing, as for a
resource; `clay state mv` keeps each resource.

### Interpolation

A `${...}` in a string holds one reference, one call or one name a for gives, and nothing
else, and is read as the file is parsed: one that never closes, is empty or holds anything
else is refused where it is written. A string with one is a `Template` node, its text and
what its interpolations read in order, and each of those keeps its own position. A comment
cannot sit inside one, and a map key is plain text and cannot hold one.

A string that is one `${...}` and nothing else is the value it reads, with its type:
`length = "${var.n}"` is a number if `var.n` is one. Anything else, text around it
or a second `${...}`, makes a string, and a list or map in such a string is an error.

### Heredoc

```
content = <<-EOT
  #!/bin/sh
  echo "${var.greeting}"
  EOT
```

A heredoc is a string written over lines. It opens with `<<NAME` or `<<-NAME` at the end
of a line and closes at a line holding only `NAME`, with spaces or tabs around it; that
line may be the last in the file with no line break after it. Its value is the lines
between, each with its line break.

Its text is read as written: no escapes, so `\n` stays two characters, and `#` or `"` is
text. `${...}` reads a reference, a call or a name a for gives as in a quoted string, and
`$${` is the text `${`.

`<<-` finds the smallest indent among the lines with text on them and takes it off every
such line, so the text can sit at the block's indent. A tab counts as one character, as a
space does, and a line that opens with `${...}` has no indent. A line of only spaces or
tabs keeps only its line break, so the value holds no whitespace you cannot see.

A heredoc is a value; it cannot be a block label or a map key.

## AST

Every node carries the position it was parsed at, so an error about it can point at the
source.

```ts
interface Position {
  file: string;
  line: number;
  column: number;
}

type AttributeValue =
  | { type: 'String'; value: string; position: Position }
  | { type: 'Template'; value: (string | Reference | Call | Bound)[]; position: Position }
  | { type: 'Number'; value: ExactNumber; position: Position }
  | { type: 'Boolean'; value: boolean; position: Position }
  | { type: 'Null'; position: Position }
  | Reference
  | Call
  | Bound
  | For
  | { type: 'List'; value: AttributeValue[]; position: Position }
  | { type: 'Map'; value: Record<string, AttributeValue>; position: Position };

type Step = { name: string } | { key: string | number };

type Reference = { type: 'Reference'; value: Step[]; position: Position };

type Call = { type: 'Call'; name: string; args: AttributeValue[]; path: Step[]; position: Position };

type Bound = { type: 'Bound'; value: Step[]; position: Position };

type For = {
  type: 'For';
  keyName?: string;
  valueName: string;
  collection: AttributeValue;
  key?: AttributeValue;
  body: AttributeValue;
  grouped?: true;
  position: Position;
};

interface ResourceBlock {
  type: 'Resource';
  resourceType: string;
  name: string;
  count?: AttributeValue;
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
  position: Position;
}

interface DataBlock {
  type: 'Data';
  dataSourceType: string;
  name: string;
  attributes: Record<string, AttributeValue>;
  position: Position;
}

interface VariableBlock {
  type: 'Variable';
  name: string;
  attributes: Record<string, AttributeValue>;
  valueType?: Type;
  position: Position;
}

interface OutputBlock {
  type: 'Output';
  name: string;
  value: AttributeValue;
  sensitive?: true;
  position: Position;
}

interface ModuleBlock {
  type: 'Module';
  name: string;
  count?: AttributeValue;
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
  position: Position;
}

interface LocalBlock {
  type: 'Local';
  name: string;
  value: AttributeValue;
  position: Position;
}

type Statement = ResourceBlock | DataBlock | VariableBlock | OutputBlock | ModuleBlock | LocalBlock;
type Program = Statement[];
```

A `Reference` holds its parts in order, each as it was written: `{ name }` after a dot,
`{ key }` in brackets, a string or a number. `local_file.a.tags["env"]` is
`[{ name: 'local_file' }, { name: 'a' }, { name: 'tags' }, { key: 'env' }]` and
`var.names[0]` is `[{ name: 'var' }, { name: 'names' }, { key: 0 }]`. A `Call` holds its
arguments in order, and in `path` the steps written after it, as a reference holds its
own. A `Bound` is a name a for gives, read in its body, with its steps as a reference
holds them. A `For` that makes an object holds its key in `key`, and `grouped` when `...`
follows the value. A `VariableBlock` holds its type in `valueType` as the `Type` a schema
names, `any` as `dynamic`. A `locals` block is a `LocalBlock` for each of its names,
`{ type: 'Local', name, value }`, placed at the name.

## Errors

A parse error is a `ConfigError` with the message and the position where it went wrong:
the token the parser stopped on, or the escape inside a string it cannot read. The lexer
throws the same for a character it does not know, a string not closed on its line, and a
`${` or a heredoc never closed.

## Not in the language

- Operators; a value is a literal, a reference, a function call or a for expression
- A for that filters with `if`
- `depends_on`, lifecycle blocks, provisioners
- Nested blocks inside a block
- Any file other than `main.clay`

`TASKS.md` lists what is planned.
