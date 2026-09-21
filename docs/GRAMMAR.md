# Grammar

What the parser in `packages/parser` accepts. A configuration is one file, `main.clay`,
in a directory; a module is another directory with its own `main.clay`.

## Tokens

| Token        | Pattern                  | Notes                                                                |
| ------------ | ------------------------ | -------------------------------------------------------------------- |
| `IDENTIFIER` | `[A-Za-z_][A-Za-z0-9_]*` | Block kinds, attribute names, reference parts; not `true` or `false` |
| `STRING`     | `"[^"]*"`                | No escapes; a `"` cannot appear inside; may span lines               |
| `NUMBER`     | `[0-9]+`                 | Integers only; no sign, no decimal point                             |
| `BOOLEAN`    | `true`, `false`          |                                                                      |
| `LBRACE`     | `{`                      |                                                                      |
| `RBRACE`     | `}`                      |                                                                      |
| `LBRACKET`   | `[`                      |                                                                      |
| `RBRACKET`   | `]`                      |                                                                      |
| `COMMA`      | `,`                      |                                                                      |
| `ASSIGN`     | `=`                      |                                                                      |
| `DOT`        | `.`                      |                                                                      |
| `EOF`        |                          | Ends every token stream                                              |

Whitespace and comments are skipped. A comment runs from `#` or
`//` to the end of the line. Every token carries the file, line and column it starts at.

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

`attributes` is zero or more `name = value` pairs, in any order, without separators, and
no name twice.
`output` takes exactly one attribute and it must be `value`.

What the engine reads from each:

| Block      | Reads                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `resource` | Every attribute goes to the provider                                                                  |
| `data`     | Every attribute goes to the provider's `read`                                                         |
| `variable` | `default`; any other attribute is parsed and ignored                                                  |
| `output`   | `value`                                                                                               |
| `module`   | `source`, a literal string naming a directory relative to the file; every other attribute is an input |

## Values

```
value   = STRING | NUMBER | BOOLEAN | reference | list | map
list    = "[" [ value { "," value } [ "," ] ] "]"
map     = "{" { key "=" value [ "," ] } "}"
key     = IDENTIFIER | STRING
```

A list needs a comma between items and may end with one. A map does not need commas.
A map key may be a bare identifier or a quoted string, and appears once; a block kind is
a fine identifier, `true` and `false` are not.

### References

```
reference = IDENTIFIER { "." IDENTIFIER }
```

A bare reference is a value on its own: `path = var.dir`. Inside a string it is written
`${...}`. The first part says what it reads:

| First part | Reads                                                | Example                     |
| ---------- | ---------------------------------------------------- | --------------------------- |
| `var`      | A variable or input of the same module               | `var.name`                  |
| `data`     | An attribute a data source read                      | `data.local_file.f.content` |
| `module`   | An output of a module called in the same file        | `module.app.url`            |
| anything   | An attribute of the resource with that type and name | `local_file.a.content`      |

A resource's `id` is what the provider assigned on create. Reaching into a module
(`module.app.local_file.a`) is refused; a module is read through its outputs.

### Interpolation

A string that is one `${...}` and nothing else is the referenced value itself, with its
type: `length = "${var.n}"` is a number if `var.n` is one. Anything else, text around it
or a second `${...}`, makes a string, and a list or map in such a string is an error.

## AST

Every node carries the position it was parsed at, so an error about it can point at the
source. The listing shows what the parser fills; `ResourceBlock` also has an optional
`modulePath` that the engine sets when it loads a module.

```ts
interface Position {
  file: string;
  line: number;
  column: number;
}

type AttributeValue =
  | { type: 'String'; value: string; position: Position }
  | { type: 'Number'; value: number; position: Position }
  | { type: 'Boolean'; value: boolean; position: Position }
  | { type: 'Reference'; value: string[]; position: Position }
  | { type: 'List'; value: AttributeValue[]; position: Position }
  | { type: 'Map'; value: Record<string, AttributeValue>; position: Position };

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

A `Reference` holds the dotted parts split up: `local_file.a.content` is
`['local_file', 'a', 'content']`.

## Errors

A parse error is a `ConfigError` with the message and the position of the token the
parser stopped on. The lexer throws the same for a character it does not know.

## Not in the language

- Negative and decimal numbers
- Escape sequences in strings
- Expressions, operators and functions; a value is a literal or a reference
- `count`, `for_each`, `depends_on`, lifecycle blocks, provisioners
- Nested blocks inside a block
- Any file other than `main.clay`

`TASKS.md` lists what is planned.
