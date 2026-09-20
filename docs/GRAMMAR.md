# Clay Grammar Specification

## 1. Basic Structure

Clay uses a declarative syntax composed of **Blocks** and **Attributes**.

```hcl
resource "type" "name" {
  key = "value"
  number = 42
  boolean = true
}
```

## 2. Token Definitions

The Lexer recognizes these tokens:

| Token Type   | Pattern / Example             | Description            |
| :----------- | :---------------------------- | :--------------------- |
| `IDENTIFIER` | `resource`, `path`, `content` | A name.                |
| `STRING`     | `"hello world"`               | Double-quoted strings. |
| `NUMBER`     | `123`, `4.5`                  | Numeric values.        |
| `BOOLEAN`    | `true`, `false`               | Boolean values.        |
| `LBRACE`     | `{`                           | Start of a block.      |
| `RBRACE`     | `}`                           | End of a block.        |
| `ASSIGN`     | `=`                           | Assignment operator.   |
| `DOT`        | `.`                           | Reference separator.   |
| `COMMENT`    | `# ...` or `// ...`           | Ignored by parser.     |

There are no keywords. `data = "x"` is an attribute and `data "t" "n" {` is a block; the
parser tells them apart by position, not by the word.

## 3. Supported Block Types

### Resource Block

```hcl
resource "local_file" "config" {
  path = "/tmp/config.json"
  content = "Hello World"
}
```

### Variable Block

```hcl
variable "environment" {
  type = "string"
  default = "dev"
}
```

### Output Block

```hcl
output "file_path" {
  value = local_file.config.path
}

output "greeting" {
  value = "Hello ${var.environment}!"
}
```

## 4. Value Types

### Primitive Types

- **String:** `"hello"`
- **Number:** `42`, `3.14`
- **Boolean:** `true`, `false`

### Complex Types

- **List:** `["a", "b", 1, true]`
- **Map:** `{ key = "value", "quoted_key" = 42 }`

### References

- **Variable:** `var.region`
- **Resource:** `local_file.config.path`

### String Interpolation

```hcl
content = "Hello ${var.name}! Version: ${var.version}"
```

**Reference Format:**

```
<type>.<name>.<attribute>
```

Examples:

- `var.environment` → Variable reference
- `local_file.base.path` → Resource attribute reference

## 5. Abstract Syntax Tree (AST)

```typescript
type Program = Statement[];

type Statement = ResourceBlock | VariableBlock | OutputBlock;

interface ResourceBlock {
  type: 'Resource';
  resourceType: string;
  name: string;
  attributes: Record<string, AttributeValue>;
}

interface VariableBlock {
  type: 'Variable';
  name: string;
  attributes: Record<string, AttributeValue>;
}

interface OutputBlock {
  type: 'Output';
  name: string;
  value: AttributeValue;
}

interface AttributeValue {
  type: 'String' | 'Number' | 'Boolean' | 'Reference' | 'List' | 'Map';
  value: string | number | boolean | string[] | AttributeValue[] | Record<string, AttributeValue>;
}
```

## 6. Comments

```hcl
# Single line comment
// Also single line comment

resource "local_file" "example" {
  path = "/tmp/file.txt"  # Inline comment
  content = "data"
}
```

## 7. Example Configurations

### Simple File Creation

```hcl
resource "local_file" "welcome" {
  path = "./welcome.txt"
  content = "Hello Clay!"
}
```

### Multiple Resources

```hcl
resource "local_file" "base" {
  path = "/tmp/base.txt"
  content = "Base content"
}

resource "local_file" "derived" {
  path = "/tmp/derived.txt"
  content = "Derived content"
}
```

### With Variable References

```hcl
resource "local_file" "config" {
  path = var.config_path
  content = "Environment config"
}
```

### With Resource References

```hcl
resource "local_file" "base" {
  path = "/tmp/base.txt"
  content = "Base"
}

resource "local_file" "derived" {
  path = local_file.base.path
  content = "Uses base path"
}
```

## 8. Words with a meaning

- `resource`, `data`, `variable`, `output`, `module` start a block
- `var`, `data`, `module` start a reference into variables, data sources and module
  outputs; any other first part names a resource

## 9. Limitations

**Not Yet Supported:**

- **Meta-arguments** (`count`, `for_each`, `depends_on`)
- **Lifecycle blocks** (`create_before_destroy`, etc.)
- **Provisioners** (`local-exec`, etc.)
- **Complex Object Schemas** (Deeply nested object validation)

See [TASKS.md](./TASKS.md) for planned features.
