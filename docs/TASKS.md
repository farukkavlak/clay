# Miniform Execution Checklist

## 0. Architectural Standards

**Constraint:** Zero Runtime Dependencies (Only devDependencies allowed).

## 1. Project Initialization

**Requirement:** Setup a TypeScript Node.js environment.

- [x] Initialize `package.json`
- [x] Configure `tsconfig.json` for strict typing
- [x] Add linting tools (ESLint/Prettier)

## 2. Syntax & Parsing (The DSL)

**Requirement:** A custom, clean syntax for defining resources.

- [x] **Grammar Design:** Define allowed tokens and structure
- [x] **Lexer:** Implement tokenizer to convert string input -> Tokens
- [x] **Parser:** Implement parser to convert Tokens -> AST (Abstract Syntax Tree)
- [x] **Unit Tests:** Verify handling of valid/invalid syntax

## 3. Core Engine Logic

**Requirement:** A system to manage state, resolve dependencies, and execute changes.

**Requirement:** A modular system to manage state, resolve dependencies, and execute changes.

- [x] **`@miniform/contracts`:** Define shared interfaces (`IResource`, `IProvider`)
- [x] **`@miniform/graph`:** Implement DAG (Directed Acyclic Graph) & Topological Sort
- [x] **`@miniform/state`:** Implement JSON reader/writer & Locking mechanism
- [x] **`@miniform/planner`:** Diff Engine logic (Config vs State)
- [x] **`@miniform/orchestrator`:** The Orchestrator that binds everything together
  - [x] Provider Registry
  - [x] Config Parsing Integration
  - [x] Dependency Graph Building
  - [x] Plan Execution (CREATE/UPDATE/DELETE/NO_OP)
  - [x] Parallel Execution (Layer-based)
  - [x] State Management (Atomic writes)
  - [x] Comprehensive Tests (16 tests, 100% statement coverage)
- [x] **Integration Tests:** Verify simple apply/plan cycles
  - [x] Implement Schema Validation (Runtime type checking)
  - [x] Implement DAG & Topological Sort (No deps)
  - [x] Implement Parallel Execution (Batch-wise layers)
  - [x] Basic State Manager (JSON I/O)
  - [x] Implement Locking & Backup (Reliability)
  - [x] Implement Variables Support (`var.name` references)
  - [x] Implement Diff Engine (Plan logic)
  - [x] Implement Orchestrator (Runner)

## 4. Providers & Resource Coverage

**Requirement:** Implement specific resource types to prove the engine works.

### 4.1. Local Provider

- [x] **`@miniform/provider-local`:** Local file system provider
  - [x] `local_file` resource (create/update/delete files)
  - [x] Modular resource handler architecture
  - [x] Validation logic
  - [x] Comprehensive tests (11 tests, 100% statement coverage)

### 4.2. Future Resources

- [x] **`random_string`:** Generate random strings (good for testing state persistence)
  - Inputs: `length`, `special` (bool)
- [x] **`null_resource`:** Do nothing (good for testing dependency chains)
  - Inputs: `triggers` (map)
- [x] **`command_exec`:** Execute shell commands
  - Inputs: `command`, `cwd`

## 5. CLI Implementation

**Requirement:** Command-line interface for user interaction.

- [x] **`@miniform/cli`:** User-facing commands
  - [x] `miniform init`: Workspace setup (create .miniform/, initialize state)
  - [x] `miniform plan`: Dry-run (show diffs without applying)
  - [x] `miniform apply`: Execute changes (calls Orchestrator.apply())
  - [x] Pretty output formatting (colored diffs, progress indicators)

## 6. Future Scope: Scalable Provider Architecture

**Requirement:** Design the engine to support any provider (AWS, Azure, GitHub), not just local files.

- [ ] **Provider Interface:** Design a generic interface (Connection, CRUD methods).
- [ ] **Plugin System:** Way to load external providers (even if hardcoded initially).
- [ ] **AWS Provider (Future):**
  - `aws_s3_bucket`
  - `aws_instance`
- [ ] **Multi-Provider Support:** Handle `provider "aws" { ... }` and `provider "local" { ... }` in the same graph.

## 7. Technical Debt (Missings)

**Requirement:** List of identified gaps to be addressed in future iterations.

- [x] **State Locking:** Race condition protection (lock file).
- [x] **State Backup:** Atomic writes with backup (.bak) generation.
- [x] **Parser Error Reporting:** Detailed line/column error messages.
- [ ] **Provider Architecture Refactor**
  - [ ] Move from Singleton Provider to Instance-based Providers
  - [ ] Support provider aliases (multi-region/account support)
- [x] **State Management Abstraction**
  - [x] Interface `IStateBackend` (Remote State support)
  - [x] Decouple `StateManager` from local `fs`
  - [x] Implement `LocalBackend` for file system operations
- [x] **Orchestrator Refactoring**
  - [x] Extract `ReferenceResolver` with Strategy pattern
  - [x] Extract `ModuleLoader` component
  - [x] Extract `ActionExecutor` component
  - [x] Extract `DependencyGraphBuilder` component
  - [x] Reduce Orchestrator from 535 to 325 lines (-39%)
- [x] **Resource Addressing (Modules)**
  - [x] Implement hierarchical addressing (tree structure)
  - [x] Refactor resource map to support nested modules
- [x] **Scoped Data Sources**
  - [x] Implement module-level data source scoping
  - [x] Resolve data source references within modules
- [x] **Type System Enhancement**
  - [x] Support List, Map, and Object types in Schema
  - [x] Improve planner diffing for complex types
- [x] **Variables Support:** Support for usage of `var.name`.
- [x] **Parallel Graph Execution:** Execute independent nodes in parallel.
- [x] **String Interpolation:** `${var.x}` support (requires Lexer templates).
- [x] **Variable Blocks:** `variable "env" { default = "dev" }` parsing.
- [x] **Reference Resolution:** Planner logic to resolve `Reference` nodes to values.
- [x] **Output Blocks:** `output "name" { value = ... }` for displaying values after apply.
- [x] **Technical Debt (Phase 5: Modules)**
  - [x] **Complexity:** Refactored `Orchestrator` to reduce cyclomatic complexity (all methods <= 10).
  - [x] **Lint Warnings:** Resolved all complexity and quality warnings (0 warnings).
  - [x] **Concurrency:** Fixed `require-atomic-updates` via local caching.
  - [x] **Type Safety:** Resolved type errors and removed `any` from core engine helpers.
  - [ ] **Provisioner Performance:** Resources are applied serially within layers; could be fully concurrent.

---

## 8. Differentiation Features

### 8.1. TypeScript Config Support

- [ ] **Config File Support**
  - [ ] Parse `miniform.config.ts` files
  - [ ] `defineConfig` helper function
  - [ ] Type definitions for resources
  - [ ] Compile-time validation
- [ ] **Type Safety**
  - [ ] Provider type definitions
  - [ ] Resource attribute types
  - [ ] IDE autocomplete support

### 8.2. Programmatic API

- [ ] **Core API**
  - [ ] Export `Miniform` class
  - [ ] `plan()` method
  - [ ] `apply()` method
  - [ ] `destroy()` method
- [ ] **Event System**
  - [ ] Progress events
  - [ ] Error events
  - [ ] Completion events
- [ ] **Structured Results**
  - [ ] Return plan details
  - [ ] Return apply results
  - [ ] Resource metadata

### 8.3. Unique Features

- [ ] **Resource Snapshots**
  - [ ] `miniform snapshot create`
  - [ ] `miniform snapshot rollback`
  - [ ] `miniform snapshot list`
  - [ ] Snapshot diff
- [ ] **Visual Diff**
  - [ ] HTML diff generation
  - [ ] Syntax highlighting
  - [ ] Interactive UI
  - [ ] Export functionality
- [ ] **Cost Estimation**
  - [ ] Cost provider interface
  - [ ] AWS cost data
  - [ ] Azure cost data
  - [ ] Cost calculation
  - [ ] Cost diff

---

## 9. Core Features

### 9.1. Reference Resolution & Dependencies

- [x] **Reference Resolution in Planner**
  - [x] Resolve `local_file.config.path` to actual values
  - [x] Resolve `var.region` to variable values
  - [x] Detect circular references
- [x] **Dependency Detection from References**
  - [x] Parse references in attribute values
  - [x] Add graph edges based on references
  - [x] Validate dependency chains
- [x] **String Interpolation**
  - [x] Lexer support for `${...}` syntax
  - [x] Parser support for template strings
  - [x] Runtime interpolation in Orchestrator

### 8.2. Plan Command

- [x] **`miniform plan` Command**
  - [x] Show changes
  - [x] Colored output (+, ~, -)
  - [x] Resource count summary
- [x] **Plan File Support**
  - [x] Save plan to file (`-out` flag)
  - [x] Apply from saved plan (`miniform apply [plan-file]`)
  - [x] Plan validation and hash check

### 8.3. Output Values

- [x] **Output Block Parsing**
  - [x] Parse `output "name" { value = ... }` syntax
  - [x] Store outputs in state
- [x] **Output Display**
  - [x] Show outputs after apply
  - [x] `miniform output` command
  - [x] JSON output format

### 8.4. Better Error Messages

- [x] **Contextual Errors**
  - [x] Show file/line/column in config
  - [ ] Highlight problematic code
  - [ ] Suggest fixes ("did you mean?")
- [ ] **Provider Errors**
  - [ ] Better error messages from providers
  - [ ] Retry suggestions
  - [ ] Troubleshooting links

---

## 9. High Priority Features

### 9.1. Data Sources

- [x] **Data Source Parsing**
  - [x] `data "type" "name" {}` syntax
  - [x] Data source provider interface (`read()` method in IProvider)
- [x] **Read-Only Operations**
  - [x] Query existing resources (via provider.read())
  - [x] Use in other resources (via `data.type.name.attribute` references)

### 9.2. State Management Commands

- [x] **State Inspection**
  - [x] `miniform state list`
  - [x] `miniform state show <resource>`
- [x] **State Manipulation**
  - [x] `miniform state rm <resource>`
  - [x] `miniform state mv <old> <new>`
- [ ] **State Import/Export**
  - [ ] Import existing resources
  - [ ] Export state to JSON

### 9.3. Validation

- [x] **Config Validation**
  - [x] `miniform validate` command
  - [x] Syntax validation
  - [x] Provider schema validation
- [x] **Dependency Validation**
  - [x] Detect circular dependencies
  - [x] Validate reference paths
  - [x] Check resource existence

### 9.4. Count & For Each

- [ ] **Count Meta-Argument**
  - [ ] Parse `count = N`
  - [ ] Create N instances
  - [ ] Index access `[0]`, `[1]`, etc.
- [ ] **For Each Meta-Argument**
  - [ ] Parse `for_each = {...}`
  - [ ] Iterate over maps/sets
  - [ ] Key access `each.key`, `each.value`

---

## 10. Medium Priority Features

### 10.1. Modules

- [x] **Module Parsing**
  - [x] `module "name" { source = "..." }` syntax
  - [x] Module loading from filesystem
- [x] **Module Execution**
  - [x] Variable passing to modules
  - [x] Output from modules
  - [x] Nested modules

### 10.2. Refresh

Terraform reads every resource from its provider before the diff, so a change made by
hand shows up in the plan. Miniform plans against what it last applied.

- [ ] **Refresh before the diff**
  - [ ] `read()` on every resource type; today each returns `{}`
  - [ ] State holds what the provider returns, not only the inputs that were sent
  - [ ] `plan` refreshes first, `-refresh=false` skips it; a plan that writes state has to
        take the lock, as `apply` does

### 10.3. Lifecycle Management

- [ ] **Lifecycle Block**
  - [ ] `create_before_destroy`
  - [ ] `prevent_destroy`
  - [ ] `ignore_changes`
- [ ] **Lifecycle Execution**
  - [ ] Implement create-before-destroy logic
  - [ ] Prevent destroy protection
  - [ ] Selective attribute ignoring

### 10.4. Provisioners

- [ ] **Provisioner Parsing**
  - [ ] `provisioner "type" {}` syntax
  - [ ] Multiple provisioners per resource
- [ ] **Provisioner Types**
  - [ ] `local-exec`: Run local commands
  - [ ] `remote-exec`: Run remote commands
  - [ ] `file`: Copy files

### 10.5. Workspaces

- [ ] **Workspace Management**
  - [ ] `miniform workspace new <name>`
  - [ ] `miniform workspace select <name>`
  - [ ] `miniform workspace list`
- [ ] **Workspace Isolation**
  - [ ] Separate state per workspace
  - [ ] Workspace-specific variables

---

### 10.6. Force Unlock

A run that dies leaves its lock behind. The error names the file; a `force-unlock`
command would remove it the way Terraform's does.

- [ ] `miniform force-unlock`

## 11. Nice to Have

### 11.1. Remote State

- [ ] **Backend Interface**
  - [ ] Generic backend interface
  - [ ] State locking for remote
- [ ] **Backend Implementations**
  - [ ] S3 backend
  - [ ] Azure Blob backend
  - [ ] Local backend (default)

### 11.2. Graph Visualization

- [ ] **Graph Generation**
  - [ ] Generate DOT format
  - [ ] `miniform graph` command
- [ ] **Visualization**
  - [ ] SVG output
  - [ ] Interactive HTML

### 11.3. Auto-formatting

- [ ] **Format Command**
  - [ ] `miniform fmt` command
  - [ ] Consistent indentation
  - [ ] Sort attributes alphabetically

### 11.4. Language Server (LSP)

- [ ] **LSP Implementation**
  - [ ] Autocomplete
  - [ ] Go to definition
  - [ ] Hover documentation
- [ ] **IDE Integration**
  - [ ] VSCode extension
  - [ ] Syntax highlighting

---

## 12. Performance & Quality

### 12.1. Performance

- [ ] **Optimization**
  - [ ] Lazy state loading
  - [ ] Incremental parsing
  - [ ] Cache provider validations
- [ ] **Benchmarks**
  - [ ] Performance benchmarks
  - [ ] Memory profiling
  - [ ] Large config handling

### 12.2. Testing

- [ ] **Integration Tests**
  - [ ] End-to-end tests
  - [ ] Real provider tests
  - [ ] Multi-resource scenarios
- [ ] **Fuzz Testing**
  - [ ] Parser fuzz testing
        [ ] State corruption testing
