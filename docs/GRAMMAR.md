# Grammar

What the parser in `packages/parser` accepts. A configuration is one file, `main.clay`,
in a directory; a module is another directory with its own `main.clay`.

## Tokens

| Token             | Pattern                               | Notes                                                                   |
| ----------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `IDENTIFIER`      | `[A-Za-z_][A-Za-z0-9_-]*`             | Block kinds, attribute names, reference parts; not `true` or `false`    |
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
| `LBRACE`          | `{`                                   |                                                                         |
| `RBRACE`          | `}`                                   |                                                                         |
| `LBRACKET`        | `[`                                   |                                                                         |
| `RBRACKET`        | `]`                                   |                                                                         |
| `COMMA`           | `,`                                   |                                                                         |
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
both. Inside a `${` a line break is whitespace. A heredoc is read the same
way, a line at a time, until its closing line; one still open at the end is refused where
it opens.

There are no keywords. `resource`, `data`, `variable`, `output` and `module` start a
block only at the top level; anywhere else they are ordinary identifiers, so
`data = "x"` inside a block is an attribute.

## Blocks

A file is a sequence of blocks. Two blocks of the same kind and name in one file are an
error. A resource is named by its type and name together, so `resource "a" "x"` and
`resource "b" "x"` are different resources.

```
resource "type" "name" { attributes }
data "type" "name" { attributes }
variable "name" { attributes }
output "name" { value = value }
module "name" { attributes }
```

A `type` and a `name` are written as strings, and each has to spell an `IDENTIFIER`, since
an address joins them with `.` and a reference reads them back. A `type` cannot be `var`,
`data` or `module`, the three words a reference reads as something other than a type. A
variable cannot be named `source`, since a module call reads that as the module's path.

`attributes` is zero or more `name = value` pairs, in any order, without separators, and
no name twice.
`output` takes exactly one attribute and it must be `value`.

What the engine reads from each:

| Block      | Reads                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `resource` | Every attribute goes to the provider                                                                  |
| `data`     | Every attribute goes to the provider's `read`                                                         |
| `variable` | `default`, and nothing else; another attribute is refused where it is written                         |
| `output`   | `value`                                                                                               |
| `module`   | `source`, a literal string naming a directory relative to the file; every other attribute is an input |

## Values

```
value   = string | heredoc | [ "-" ] NUMBER | BOOLEAN | reference | list | map
string  = OQUOTE { QUOTED_LIT | TEMPLATE_INTERP reference TEMPLATE_END } CQUOTE
heredoc = OHEREDOC { STRING_LIT | TEMPLATE_INTERP reference TEMPLATE_END } CHEREDOC
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
a fine identifier, `true` and `false` are not, and neither is `__proto__`, for an attribute
name either.

### References

```
reference = IDENTIFIER { "." IDENTIFIER | "[" ( NUMBER | string ) "]" }
```

A bare reference is a value on its own: `path = var.dir`. Inside a string it is written
`${...}`. The first part says what it reads:

| First part | Reads                                                | Example                     |
| ---------- | ---------------------------------------------------- | --------------------------- |
| `var`      | A variable or input of the same module               | `var.name`                  |
| `data`     | An attribute a data source read                      | `data.local_file.f.content` |
| `module`   | An output of a module called in the same file        | `module.app.url`            |
| anything   | An attribute of the resource with that type and name | `local_file.a.content`      |

A resource's `id` is what the provider assigned on create.

After what it names, a reference may read into the value: `.name` or `["key"]` reads a
key of a map, and `[0]` an item of a list, counted from 0. So `local_file.a.tags.env`,
`var.names[0]` and `module.app.info["url"]` each read one value. An index is written in
digits; a quoted key reads escapes as a map key does. A key the map does not have, an
index past the end of the list, or a step into a string, number or bool is refused where
the reference is written. A value not known until apply is read into at apply.

The parts before that name what is read, so each is a name even when it is quoted:
`var["region"]` is `var.region`, and `module["a.module.b"]` is refused.

A module is read through its outputs, so `module.app.local_file.a` names an output
called `local_file`, and is refused when the module has none.

### Interpolation

A `${...}` in a string holds one reference and nothing else, and is read as the file is
parsed: one that never closes, is empty or holds anything else is refused where it is
written. A string with one is a `Template` node, its text and its references in order, and
each reference keeps its own position. A comment cannot sit inside one, and a map key is
plain text and cannot hold one.

A string that is one `${...}` and nothing else is the referenced value itself, with its
type: `length = "${var.n}"` is a number if `var.n` is one. Anything else, text around it
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
text. `${...}` reads a reference as in a quoted string, and `$${` is the text `${`.

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
  | { type: 'Template'; value: (string | Reference)[]; position: Position }
  | { type: 'Number'; value: ExactNumber; position: Position }
  | { type: 'Boolean'; value: boolean; position: Position }
  | Reference
  | { type: 'List'; value: AttributeValue[]; position: Position }
  | { type: 'Map'; value: Record<string, AttributeValue>; position: Position };

type Reference = { type: 'Reference'; value: (string | number)[]; position: Position };

interface ResourceBlock {
  type: 'Resource';
  resourceType: string;
  name: string;
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
  position: Position;
}

interface OutputBlock {
  type: 'Output';
  name: string;
  value: AttributeValue;
  position: Position;
}

interface ModuleBlock {
  type: 'Module';
  name: string;
  attributes: Record<string, AttributeValue>;
  position: Position;
}

type Statement = ResourceBlock | DataBlock | VariableBlock | OutputBlock | ModuleBlock;
type Program = Statement[];
```

A `Reference` holds its parts in order, a key as a string and an index as a number:
`local_file.a.tags["env"]` is `['local_file', 'a', 'tags', 'env']` and `var.names[0]` is
`['var', 'names', 0]`.

## Errors

A parse error is a `ConfigError` with the message and the position where it went wrong:
the token the parser stopped on, or the escape inside a string it cannot read. The lexer
throws the same for a character it does not know, a string not closed on its line, and a
`${` or a heredoc never closed.

## Not in the language

- Expressions, operators and functions; a value is a literal or a reference
- `count`, `for_each`, `depends_on`, lifecycle blocks, provisioners
- Nested blocks inside a block
- Any file other than `main.clay`

`TASKS.md` lists what is planned.
