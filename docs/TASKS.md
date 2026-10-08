# Tasks

What Clay does today is in the README. This is what comes next, in the order it is
worth doing. Terraform is named where it has solved the same problem.

## Bugs

Wrong behaviour, each seen and reproduced. These come before everything below, one
change each.

- [x] A module that names itself, or two that name each other, overflow the stack.
      `ModuleLoader` keeps no record of the directories on the path it is loading, so a
      `source` cycle recurses until Node dies. The graph refuses a reference cycle by
      name; a module cycle should be refused the same way
- [x] A module input the module never declares is accepted, and a misspelled one falls
      back to the default in silence. `declareInputs` sets every attribute of the
      `module` block as a variable, and nothing checks the module has a `variable` of
      that name; `contnet = "x"` applies the default and says nothing. Terraform: "An
      argument named "contnet" is not expected here"
- [x] A reference that reads deeper than what it names drops the parts in between in
      silence: `var.v.bogus` gives the variable, and `local_file.a.tags.content` reads the
      `content` attribute as if `tags` were never written. Both were seen in a plan that
      said nothing. Every part is read or refused, never dropped
- [x] An attribute a `variable` block does not use is accepted in silence.
      `declareVariables` reads `default` and nothing else, so `descriptoin = "x"` is
      dropped and `defualt = "x"` is reported as `variable "v" has no value`, which names
      the wrong problem. `type` and `description` are read by nobody either, so what a
      `variable` block may hold is the call the fix makes
- [x] A module that declares `variable "source"` can never be given one. `declareInputs`
      skips the key, because the caller's `source` is the module's path, so a declaration
      with a default falls back to it in silence and one without fails with
      `module.m: variable "source" has no value`, which names the caller's input as
      missing when it was written. Terraform reserves the name and refuses the
      declaration
- [x] A resource named `a.b` is created and can never be addressed again. The parser
      takes any string as a name, `Address.toString` joins with dots and `Address.parse`
      splits on them, so `state show`, `state rm` and a reference all fail on the key an
      apply wrote. The same for a type or name spelled `module`. A name is an identifier,
      as in Terraform
- [x] `LocalBackend.write` swallows every backup failure, not only "nothing to back up".
      The `catch` around `access` and `copyFile` is bare, so when the backup cannot be
      written the old state is replaced anyway, with no backup and no message. Only
      `ENOENT` on `access` means a first write
- [x] A map key can impersonate the unknown value. `UNKNOWN` is a plain object with the
      key `@@clay/unknown`, so `triggers = { "@@clay/unknown" = true }` is unknown to the
      planner and plans an update forever. A sentinel is something a configuration cannot
      spell
- [x] An integer above 2^53 is rounded in silence: `12345678901234567890` plans as
      `12345678901234567000`. A number is kept exactly from the configuration to state,
      a plan file and a provider, as Terraform keeps it
- [x] A reference in a `variable` default that a module call gives a value in place of
      is never checked. `default = var.nope` in a module called with `x = "given"` is
      valid to `clay validate` and plans, while the same module called without `x` is
      refused with `variable "nope" is not defined`. The graph keeps the caller's input
      under the variable's key and drops the default, so nothing reads it. A default is
      a constant now, as in Terraform: a reference or a function call in it is refused
      where it is written
- [x] A block that makes no instance is never read. `tolist([1, true])` in a resource
      with `count = 0`, in an output of a module called with `count = 0`, or given to its
      untyped variable is valid to `clay validate`; with `count = 1` it is refused. A
      template also stopped at its first part not known yet, so a mistake after it passed
      the plan. Every value is read once now, as written, and held to the type of the
      attribute or variable it is given to: a reference is not known yet, of the type its
      variable or schema names, and a for over a collection not known yet reads its body
      once. Terraform reads each block once the same way
- [x] A saved plan made an instance its `count` no longer gave. With
      `count = length(data.local_file.size.content)` and the file shorter by the apply, the
      plan's last index was still created. An apply read `for_each` again and never
      `count`; it reads both now and refuses an index or a key they do not give
- [x] A saved plan was held to the instances the apply reads in one direction only. With
      `count = length(data.local_file.size.content)` and the file longer by the apply, the
      new index was skipped in silence; with the plan deleting the last index and the file
      longer again, it was deleted though the count gave it. `for_each` did the same. A
      plan carries what its data sources gave now, so an apply reads the count its plan read
- [x] A data source forgot what it was given. With `data "local_file" "f" { path = "x" }`,
      `data.local_file.f.path` read as `null`: an output showed nothing for it, and
      `"${data.local_file.f.path}"` was refused as null. The read returned only `content`,
      and an attribute it left out became null, the one the block set among them.
      Terraform's provider returns the arguments with what it read. Clay keeps what the
      configuration gave, and refuses a read that changes it as a provider bug
- [x] A plain `clay apply` read module files twice: once for the plan, and again after
      the confirmation. With `count = 2` in `m/main.clay` changed to `count = 3` in
      between, the output said 3 though the plan showed 2; with the plan deleting index 2
      and the file back at `count = 3`, the same. An error in the run quoted the changed
      file. Terraform holds the configuration it planned in memory. Now a plain apply
      runs the files its plan read, as `apply <plan>` does
- [x] A name after a dot was read as a `for_each` key, so a reference with its key left
      out was read as another instance and refused for the wrong reason. With `for_each`
      on `local_file.f`, `content = local_file.f.content` in another resource gave
      `content is an object, where local_file takes a string`; with `for_each` on
      `module.web`, `module.web.path.x` gave `module "web" has no output "x"`. Terraform
      reads a key only in brackets. Now a key is written in brackets, as in
      `local_file.f["key"]`, and a name after a dot there is refused as a missing key
- [x] An object a provider gave back with an optional attribute as `null` was refused as
      a provider bug. With an object type whose `b` is optional, a configuration that set
      `{ a = "1" }` and a provider that returned `{ a = "1", b = null }` failed, for a
      resource at apply and for a data source at read, since the two objects had
      different keys. Now an object of a schema's type holds every attribute, and an
      optional one left out is `null`, from the configuration and from a provider alike,
      as in Terraform and as a variable's type already did. A provider that gives it a
      value the configuration did not is still refused, by the attribute's name
- [x] One plan could read a module file twice. Two `module` blocks with the same `source`
      each read it, so a file changed between the two reads was planned from two versions,
      and `plan --out` saved only the second. Now a load reads each file once
- [x] An error's source line is read off the disk again. `plan`, `validate` and a plain
      `apply` that fails to plan described a positioned error from `DiskFiles`, so a file
      changed after it was parsed showed the caret under a line of the new version. Now
      each command reads a file once and quotes what it read
- [x] A default of the wrong type was reported at the value that left it to the default,
      not at the default. With `type = object({ port = optional(number, "eighty") })` and
      `{}` given, the caret was under `{}`, for a variable, an output, and a variable a
      data source read at load. Now every default is checked as the configuration loads,
      before anything reads it

## 1. Language

The parser takes literals, references and function calls, with no operators yet. A real
configuration hits each of these early.

- [x] Negative and decimal numbers, with an exponent, as HCL writes them; the minus is a
      token of its own, so a number never swallows the minus of a subtraction
- [x] String escapes: `\"`, `\n`, `\r`, `\t`, `\\`, `\uNNNN`, `\UNNNNNNNN`, and `$${` for a
      literal `${`, as HCL reads them; any other escape is refused
- [x] Heredoc strings, `<<EOT` and `<<-EOT`: text as written, `${...}` read, and with
      `<<-` the shared indent taken off
- [x] Refuse a raw line break in a quoted string, as HCL does, once heredocs exist to take
      its place; `\n` is the other way to write one
- [x] Nested access: `local_file.a.tags.env` and `var.list[0]`; today `[` after a
      reference is a parse error, and a reference that reads deeper than one attribute is
      refused where it is read
- [x] A quoted key inside `${...}`: `"${var.tags["a.b"]}"`. The lexer ends a string at the
      first unescaped quote, so the quote inside the interpolation ends it. HCL reads a
      `${...}` to its closing brace, quotes and all
- [x] A reference is a type, not a string. Today it travels as `string[]` and four places
      split it on dots to read a part back. An instance key cannot be added to a shape
      that thin, so this comes before `count`
- [x] `count` on a resource, with `[0]` access and `count.index`; an address grows an
      instance key, the way Terraform's `addrs.AbsResourceInstance` does
- [x] Adding `count` to a resource moves `a` to `a[0]` in the plan, and taking it off
      moves `a[0]` back, rather than destroying one and creating the other. Terraform
      does this since 1.1
- [x] `for_each` on a resource, over a map or a list of strings, with `["key"]` access and
      `each.key`, `each.value`. A string twice in the list is refused where it is
      written; Terraform's `toset` drops the second in silence
- [x] `count` on a module: one instance of everything in it for each index,
      `module.name[0]`, with `count.index` in the call's inputs and `module.name[0].out` to
      read one. A module address has its own type, and a key on each module
- [x] `for_each` on a module: `module.name["key"]`, with `each.key` and `each.value` in the
      call's inputs
- [x] Adding `count` to a module that exists moves what is in it to `module.name[0]`, and
      taking it off moves it back, as for a resource. Two places state may keep it are
      refused rather than guessed between
- [x] A resource to be created or changed is read at plan time as its configuration sets
      it, so `count = random_string.s.length` plans on a fresh state. Its id, what the
      provider computes, and what the configuration does not know yet, stay unknown
- [x] A list or a map is known as far as its items are: an item only the apply makes is
      unknown on its own, in the plan, its file and what it shows, and the rest is known
- [x] A `for_each` map whose keys are known and whose values are not plans its keys:
      `{ a = random_string.s.id }` plans `["a"]` with `each.value` unknown. A list needs its
      items, since they are its keys
- [x] A whole instance as a value: `local_file.a`, `local_file.a[0]` and
      `local_file.a["key"]` are each an object of every attribute in the schema
- [x] Every instance of a resource as one value: `local_file.a` is the list of its
      instances under `count` and a map of them by key under `for_each`. Terraform makes a
      tuple and an object, since a dynamic attribute can give its instances different
      types; a Clay value keeps its schema's type, so they share one and `validate` knows it
- [x] Every instance of a module as one value: `module.web` as an object of its outputs,
      and with `count` or `for_each` as a list or a map of them. Terraform makes a tuple
      and an object where an output has no declared type; Clay joins each output into one
      type across the instances, as `tolist` does, and refuses outputs that cannot be joined
- [x] An output names its type: `output "url" { type = string, value = ... }`, with
      `optional(type, default)` as a variable's type has it. Its value is given as that
      type at plan and at apply, and `validate` knows `module.web.url` is a string before a
      plan. Terraform has `type` on an output and converts the value the same way
- [x] `path.module` and `path.root`, so a module can name a file next to itself. Both are
      relative to the root, where `clay` runs, so a plan or a state reads the same on
      another machine
- [ ] `path.cwd`, once Clay can run from a directory other than the root
- [x] A function is called by its name, `length(var.names)`, as a value or inside
      `${...}`. `length` counts the items of a list, a set or a map and the characters of
      a string. A name no function has is refused where it is written
- [x] `tolist` and `toset`, so a configuration can read a member of a set:
      `tolist(x)[0]`. Their items take one type; a number beside a boolean, and objects with
      other names, are refused where Terraform refuses the first and makes the second a map
- [x] A `for` expression that makes a list: `[for i, n in var.names : "${i}-${n}"]`. A
      set with a member not known yet leaves the whole for to the apply, where Terraform
      gives it item by item and an apply that sorts the new member first moves every item
- [x] A `for` expression that makes an object, `{for k, v in m : k => v}`. A key two
      items give is refused, and `...` after the value groups them
- [ ] `if` in a `for` expression, once operators can write a condition
- [x] A variable names its type: `variable "x" { type = set(string) }`. An object given
      an attribute its type does not name is refused, where Terraform drops it in silence
- [x] `optional(type)` and `optional(type, default)` on an attribute of a variable's
      object type. One left out, or given `null`, takes its default, or `null` where it
      names none
- [ ] `sensitive = true` on an output: its value is hidden in what `plan`, `apply` and
      `clay output` print, and `clay output --json` still gives it. Terraform prints
      `<sensitive>` and keeps the flag beside the value and its type in state, where the
      value stays in plain text
- [x] A module `source` has a kind. Terraform reads a local path only when it starts with
      `./` or `../` and treats anything else as a registry address; Clay joins whatever it
      is onto the parent directory, so an absolute path is read as well

## 2. Engine

### Refresh

Terraform reads every resource from its provider before the diff, so a change made by
hand shows up in the plan. Clay does too.

- [x] A provider reads a resource back, as it reads a data source
- [x] State holds what the provider returns, not only the inputs that were sent
- [x] `plan` and `apply` refresh first, `--refresh=false` skips it. A plan writes nothing,
      as in Terraform, and an apply forgets a resource the plan found gone
- [x] "Changed outside Clay" lists a value changed by hand, not only a resource deleted by
      hand. Today such a value shows only as an update whose old value is the one found,
      where Terraform lists both under "Objects have changed outside of Terraform"

### What a plan carries

A `PlanAction` holds the attributes as the parser wrote them, and `apply` resolves them
again. Terraform's apply evaluates the configuration again too, since a value only an
apply makes is known only then, and its saved plan carries the configuration for that.
What lets it promise to do what the plan showed is a check: a value the plan showed as
known that comes out otherwise stops the run.

- [x] A plan carries the state it was made against and the state the refresh read, as
      Terraform's does. The apply runs on what was read, and what changed outside Clay is
      shown from the two
- [x] An action carries the values it was planned with, and `apply` stops before a
      resource whose value the plan showed as known resolves to another

### Computed attributes

`create` and `update` return the whole resource, a schema marks what the provider
computes, and `plan` refuses a reference to an attribute a resource will never have. The
provider plans what a resource to create or change will hold.

- [x] `create` and `update` return the resource's attributes; state holds them
- [x] Schema marks computed attributes, so `plan` can refuse a reference to an attribute
      that will never exist
- [x] `command_exec` exposes `stdout`; `random_string` exposes `result`
- [x] The provider takes part in the plan: asked what a resource to create or change will
      hold, it says which values are known, which only the apply makes, and where a change
      replaces the resource; a replacement is planned again as a create. A plan that
      changes a value the configuration sets is refused, and the id of a resource changed
      in place is known. Terraform's `PlanResourceChange`
- [x] A value the apply returns that differs from one the plan showed as known stops the
      run with an error that says the provider has a bug, as Terraform's "inconsistent
      result after apply" does. It names the resource type, since a provider has no name
      yet. The plan was approved, so a different result is never taken in silence. A
      value returned that the plan did not have is refused the same way, since the next
      plan would read it as removed and plan an update every run
- [x] A schema can mark a computed value `kept`: made with the resource and the same
      until it is replaced, so a change in place plans it as it was read and what reads it
      does not change. A schema that keeps a value it does not compute is refused.
      Terraform's framework does this with `UseStateForUnknown`
- [x] A resource's id is one of its attributes, as Terraform has it, so the plan and the
      apply check hold it like any other value. A provider finds a resource by what it
      last held, and the engine keeps no id of its own
- [x] The apply plans each resource again with what it now knows, and holds what it
      returns to that plan. A replacement is planned again as a create. A final plan
      that changes a value the plan knew, or replaces what the plan changed in place,
      stops the run before anything changes, as a bug in the provider. `local_file`
      plans its id from an absolute path. Terraform plans again at apply and refuses a
      final plan that differs
- [x] `create` and `update` are given what the plan made at apply says the resource will
      hold, beside the configuration's values, so a value the provider planned, such as a
      kept id, is not worked out a second time. Terraform's `ApplyResourceChange` is given
      the planned state

### Schema-driven validation

`SchemaDefinition` carries a `type` and `required`. A type is whole, however deep:
`list(set(string))`, an object of named types, a tuple. The engine holds a resource's and
a data source's names and values to them, converts a number, a bool or
a string to the one the schema names where it can, refuses a computed value the
configuration sets unless it is also optional, and refuses a schema that keeps a value it
does not compute. `planFromSchema` reads `forceNew`, `computed` and `kept` for a provider.
A provider's `validate` checks only what a schema cannot say: an empty path or command, a
length below 1.

- [x] The engine validates inputs against the schema before it asks the provider. A name
      the schema does not have and a required one left out are refused once per block,
      where they are written; each value known is held to its type, in every item it
      holds, at plan and again at apply once the apply knows it. Terraform: "An argument
      named "contnet" is not expected here"
- [x] Providers keep `validate` for what a schema cannot say
- [x] A data source has a schema too, apart from a resource of the same type. Its block is
      checked as a resource's is, before it is read; what it reads is held to the names
      the schema has, and a schema that marks a value `forceNew` or `kept` is refused
- [x] A resource with a value that is not known yet has its known values checked. The
      provider's `validate` sees every value, UNKNOWN where only the apply makes one, and
      checks what it knows; the apply checks the rest once it knows them
- [x] A number or a bool where the schema wants a string becomes its text, and a string
      that spells a number or a bool where one is wanted becomes it, as Terraform does.
      Any other string there is refused where it is written. `null_resource` takes any
      map as `triggers`, since it only compares them
- [x] A schema type can be a `set`, whose order is not a change. A set from the
      configuration and from every provider answer is held in one order, with each member
      once, so every comparison sees the same members as the same value
- [x] A set member is refused by index, since its members are held sorted and
      `pool.p.members[0]` would read whichever sorts first. A set read from a resource
      or a data source stays a set through variables, module inputs and outputs, so
      `var.members[0]` and `module.m.out[0]` are refused too. Files and providers still
      see a list in one order. Terraform: "Elements of a set are identified only by
      their value"
- [x] A schema type nests as deep as it needs: `list(set(string))`, an object whose
      attributes are required unless it lists them as optional, and a tuple with a type
      for each position. A type a provider gives is checked whole when its schema is read.
      Terraform: `object({ a = string, b = optional(number) })`
- [x] Every value carries its type through the engine, not only where a schema names it.
      A written list is a tuple and a written map an object; a value from a provider or a
      state has the type its schema names; a value not known yet has the type it will
      have, so one of a kind the attribute does not take is refused at plan. Messages
      name the type: `content is a tuple, where local_file takes a string`. Terraform:
      cty, where a value and its type travel together
- [x] A provider that plans, makes or reads a value its schema does not hold is refused
      as its bug, named by the steps to the value. A resource it made is kept in state
      first, since it exists. A name it gives no value, `{ tags: undefined }`, is a name
      left out, as the state file drops it; in a list it is refused
- [x] A set with a member not known yet keeps the members it knows, and the unknown one
      after them; its size is known at apply. The apply holds it to the plan by its
      members, not by where each sorts. Terraform does the same. Taken as a list, or
      where no type is named, it is not known as a whole until then: it has no order yet
- [x] `null`. An attribute set to it is left out, so a required one is refused where it
      is written; inside a list, a map or a set it stays. Reading into it, joining it into
      a string, or giving it to `count` or `for_each` is refused where it is written.
      `null` is a keyword, so no block is named it. An attribute only the provider makes
      takes `null`, and is made as if nothing were written. An attribute of a resource
      or a data source that the schema has and nothing sets reads as `null`. Terraform:
      "behaves as though you had completely omitted it"
- [x] The plan shows a set change as the members it loses and gains, `- "a"` and
      `+ "c"`, for an attribute and for an output. State and a plan hold each root
      output with its type, as Terraform's state does, and `clay output --json` prints
      it. An output whose type alone changes is a change and is shown by the two types;
      Terraform counts it as a change too, but its plan shows nothing for it. Terraform
      shows a changed set output item by item, by index
- [ ] A value not known yet is refused at plan where its type can never be joined into
      a string: `"x-${thing.a.tags}"` with `tags` a map. Today the plan passes and the
      apply fails after `thing.a` is made. Terraform also waits for the apply
- [ ] A step into a value not known yet is refused at plan where its type can never take
      it: an index into a set or a map, a key into a list, a name its object type does not
      have, any step into a string. Today the apply refuses it, and a block that makes no
      instance never: in a block with `count = 0`, `[for log in local_file.logs : log.contnet]`
      is valid. Terraform refuses at plan: "Can't access attributes on a primitive-typed
      value (string)"
- [ ] The body of a `for` over a collection known to be empty is never read. With
      `count = 0` on `local_file.logs`, `[for log in local_file.logs : log.contnet]` is
      valid, and with `count = 2` it is refused. A body is read once against the item type
      when the collection is unknown, and should be when it is empty
- [ ] A value not known yet is checked only by its own kind, not by the types of what it
      holds. `var.l` of type `list(number)` given to a variable of type `list(bool)` is
      valid to `clay validate` when no instance reads it: a list is taken as a list, and
      its numbers are never checked. Its type says they can never be booleans. Terraform
      refuses it
- [ ] A provider that says it computes a value and does not return it at apply is not
      refused: the value is left out and reads as `null`. What reads it then fails
      without naming the provider: `content = stamp.a.made` ends in
      `local_file requires "content"`. To weigh: refuse it as the provider's bug when the
      plan showed it as known after apply and the schema does not mark it optional.
      Terraform lets a value not known at plan come to null

### Data sources in the graph

Data sources were read while the config loaded, before any resource existed and before any
module output had a value, so one that read either failed at plan.

- [x] Data sources are graph nodes, read in dependency order and once per run. Read at load,
      one whose input read a resource the plan changed got the value in state, while a
      resource that read it got the value the plan set. One that read every instance of
      a resource with `count` or `for_each`, `local_file.logs`, was refused, since no count
      was read yet. Now each is read after what it reads
- [ ] A data source in a module called with `count` or `for_each` is refused, since it is
      one node, read once. It should be read once for each instance of its module; test that end to end with a module called with `count` and one
      with `for_each`, nested ones too
- [ ] `count` and `for_each` on a data source, as on a resource
- [x] A data source fed by a pending resource is `(known after apply)`. It waits for the
      apply when what it reads is not known yet, or when it reads a resource the plan
      changes, through variables and module outputs too, so it never reads the world
      before the apply. The plan shows `<= data.x.y will be read during apply`. Terraform
      waits only for a resource read directly, so a local in between reads the old value
- [x] Their values travel in the plan, as in Terraform, so `apply` reads none the plan
      read again. `runPlan` still parses and builds the graph on its own, since a saved plan
      brings its own configuration
- [x] `local_file` as a data source reads the file
- [ ] `clay validate` stops reading them. Checking a configuration asks the provider for
      real data today, so validating needs whatever the data source talks to
- [ ] `locals { name = "${var.prefix}-x" }`: a value a module works out once and reads by
      name as `local.name`. A variable default is a constant, so today such a value is
      written out again wherever it is read. Waits for the data sources above, so a local
      is a node worked out once for each module instance and a data source can read it

### Parallel apply

The graph sorts into layers that can run in parallel, and the runner takes them one at a
time. Runs in parallel need a context of their own: one `ScopeManager` and one
data-source map per engine, cleared on load, serve one run at a time.

- [ ] A run carries its own scopes and data-source values. The engine holds one of each
      and clears them on load, which is what limits it to one run at a time
- [ ] Resources in one layer run together; state is written once per layer

### Lifecycle

- [ ] `lifecycle { create_before_destroy = true }`: today a replacement deletes first
- [ ] `prevent_destroy`: the plan refuses to delete the resource
- [ ] `ignore_changes`: named attributes do not count as a change

### Provisioners

`command_exec` is a resource, so a command has state of its own. Terraform's provisioners
run as a step of another resource instead.

- [ ] `provisioner "local-exec" { command = "..." }` inside a resource, run after create
- [ ] `remote-exec` and `file`, once a resource can carry a connection

## 3. State

### Backends

The state is always the file `clay.state.json` next to the configuration. Where it lives
should be the workspace's choice, written once and read by every command, the way
Terraform has it since backends replaced `-state`.

- [ ] A `clay { backend "local" { path = "..." } }` block in the configuration
- [ ] `init` reads it, checks the backend answers, and remembers the choice
- [ ] A factory builds the backend from the block; `StateBackend` is the contract it
      already has to meet
- [ ] The CLI stops reading `LocalBackend.path`. It names the state file in its messages
      through a field only the local backend has, so no other backend can be put in its
      place
- [ ] An HTTP backend, since it needs no SDK: read, write, lock and unlock over four
      requests
- [ ] `init` offers to move the state when the block names a different backend than the
      one in use
- [ ] An S3 backend, with the lock a second run has to wait for; an Azure Blob backend

### Format

- [ ] A state a newer Clay wrote is refused, which is right, but an older one has no way
      forward either. Each version needs an upgrade step that reads the one before, the
      way Terraform's `states/statefile` upgrades on read

### Commands

- [ ] `clay force-unlock`: a run that dies leaves its lock behind, and the error names
      the file; this removes it, the way Terraform's does
- [ ] `clay import <address> <id>`: take over a resource that exists but is not in state
- [ ] A provider can name what identifies a resource apart from its values, for `import`
      and for finding it again. Terraform 1.12's resource identity
- [ ] `clay state pull`: print the state as JSON, for a script or a backup
- [ ] Workspaces: `clay workspace new | select | list`, one state per workspace

## 4. Providers

The CLI imports the one provider, `local`, and registers it; the registry keys providers
by resource type, and no `provider` block exists yet.

- [ ] `contracts` splits in two. It holds both the engine's contract with a provider
      (`Provider`, `Schema`) and value types the engine shares with itself (`Address`,
      `State`), so a provider written elsewhere would depend on the engine's own types.
      This comes before a provider can be loaded from a package
- [ ] Provider instances with configuration: `provider "aws" { region = "..." }`, and
      aliases for a second instance of the same provider
- [ ] A plan refreshes after the configuration loads, as Terraform does. It reads every
      resource first today, so a mistake in `main.clay` is reported only after every read
      and a read error hides it, and a provider configured by a `provider` block would be
      asked to read before it is configured
- [ ] Loading a provider from a package instead of a hard-coded import
- [ ] A provider is told where the run is. Each reads `process.cwd()` for itself, so a
      relative path means whatever the shell was in
- [ ] `null_resource` acts on its `triggers`. A change to them plans an update and the
      update does nothing
- [ ] A first remote provider to prove the shape, small enough to keep tests real: an
      HTTP or GitHub provider before an AWS one

## 5. Errors and tooling

- [x] Errors about a configuration that carry no position. Each is thrown where the
      position is at hand, and each prints as one bare line: a `module` block with no
      `source`, a `source` that names no file, a `source` cycle, a `variable` with no
      value, and the graph's dependency cycle, which knows the node but not the line and
      prints the graph's own key, `vars:a`, for a variable the configuration spells `var.a`
- [ ] An attribute name has no position of its own. Only its value is a node, so an
      error about the name points a caret at the value next to it
- [ ] A reference in a string that fails as it is resolved points at the string, not at
      the reference. The parse and the graph point at the reference; a resolver throws
      plain errors, and one of them means "not in state yet", so it cannot be wrapped blindly
- [ ] "Did you mean": a reference to a name one edit away from a declared one says so
- [ ] Provider errors carry what to do next, not only what went wrong
- [x] A module output that does not exist is reported two ways. Read from a resource,
      the graph says `module "m" has no output "x"`. Read from a data source, which
      loads before the graph, the resolver says
      `Output "x" not found in module "module.m"`, with the scope key where the
      module's name should be. The resolver says the same for an output that is declared
      but has no value yet, so the two need telling apart; once data sources are graph
      nodes, the graph refuses the undeclared one
- [ ] An output that fails to resolve reports a failure. `resolveOutput` runs outside the
      step's `try`, so a throw there ends the run with no `failed` event and nothing said.
      `readKeys`, which reads a `count` or a `for_each` again at apply, runs there too, and so do
      `expandCall`, which reads a module's `count` or `for_each` again, and the refusal of
      a saved plan's action in an instance of a module the configuration does not make
- [ ] An output may be named `__proto__`. The runner collects outputs into a plain object,
      where that name sets a prototype instead of a key, so the output disappears
- [ ] `apply` says a missing file is missing the same way twice. A missing plan file and a
      missing configuration are reported with different prefixes today
- [x] `Address.parse` says `got 1 parts` when it refuses an address
- [ ] `clay graph`: the dependency graph in DOT
- [ ] `clay fmt`: one layout for every file, so diffs show changes and not style

### Code health

Nothing here changes what Clay does. Each is a place the next change has to work around.

- [ ] `ActionExecutor.executeCreate`, `executeUpdate` and `executeDelete` are public only
      because tests call them
- [ ] `validatePlanFile` is exported although `parsePlanFile` is the way in
- [ ] `Graph.getNode` is followed by `!` at four call sites; the graph should hand back a
      node or say it has none
- [ ] `ModuleLoader.loadModuleTree` is `async` with nothing to await, and walks the same
      statements as `loadChildModule` does
- [ ] The root address is spelled three ways
- [ ] `PlanRunner` reads `?.dependencies ?? []`, which reads a missing state entry as one
      with no dependencies
- [ ] The CLI rebuilds the module file layout that `RecordingFiles` already snapshotted
- [ ] A `state show` test feeds a resource with no `attributes`, which `parseState` now
      refuses to read; the branch it covers may be unreachable
- [ ] `ActionExecutor.executeUpdate` says "the plan resolved these against an older
      state", but `action.attributes` is the parsed block and was never resolved;
      `executeCreate` does the same resolve with no comment
- [ ] `LoadedResource.uniqueId` is `address.toString()` under a second name
- [ ] The type of an object type is spelled out three times in the orchestrator, in
      `withLeftOut.ts`, `declared.ts` and `unify.ts`
- [x] Comments that restate the code: the `// e.g., "my_file"` trailers in `ast.ts`, the
      `// {` and `// }` trailers in `tokens.ts`, the `forceNew` explanations in the local
      provider

### Test health

- [x] `ReferenceResolver.spec.ts` has a test titled "resolve Array of References
      recursively" that asserts the array comes back unresolved, under a 28-line
      transcript of someone reading the code, naming an `Orchestrator.convertAttributes`
      that does not exist. It feeds a raw array, which the resolver is never handed;
      attributes arrive as a `List` node
- [ ] Two `Orchestrator.advanced` tests are titled for dependency order and for a
      reference to another resource, and each asserts only that two resources were
      created; both pass with every graph edge removed
- [x] Comments in `ModuleLoading.spec.ts` and `ModuleDataFlow.spec.ts` name
      `Orchestrator.run` and `Orchestrator.ts`, which do not exist, and ask questions
      rather than state reasons
- [ ] `describe` titles say "Phase 4" and "Phase 5", which mean nothing in the repo
- [ ] `ApplyPlan.spec.ts` says the CLI cannot be driven from a test, and four
      neighbouring specs drive it
- [ ] `Graph.spec.ts` hedges that a sort "depends on implementation details" and asserts
      the flattened list, where the layers are deterministic and should be asserted
- [ ] Regression tests explain what used to happen; a comment says what the test pins
- [x] Test comments of the `// Setup`, `// Verify`, `// Mock X` kind restate the line
      below them, across `Orchestrator.spec.ts`, `StateManager.spec.ts`, `Graph.spec.ts`
      and others
- [ ] No test puts a reference inside a list: `tags = [local_file.a.id]`. With
      `resolveList` passing a `Reference` node through unresolved, all 452 tests pass
- [ ] No test has a delete fail. With `PlanRunner` ignoring a failed delete and going on
      to write outputs, all 452 tests pass; the `failed` event, the kept state entry and
      the released lock on that path are unpinned. A replace whose create fails after
      the delete is untested the same way
- [x] Data sources have no end-to-end test; the only `data` block in `e2e` is an error
      case, since `LocalProvider.read` returns `{}`
- [x] The two `command_exec` "execute" tests assert only that an id came back; they pass
      with the command never run and with `cwd` ignored
- [ ] `Orchestrator.spec.ts` "should register a provider" asserts only `not.toThrow`,
      and passes with registration removed
- [ ] `ModuleDataSources.spec.ts` still hands one `emptyState()` to every test; its two
      siblings were fixed and it was missed. `ModuleOutputResolver.spec.ts` shares one
      `ScopeManager` the same way, and its "not found" test passes only because no
      earlier test set that key
- [ ] `ModuleLoading`, `ModuleDataFlow` and `ModuleDataSources` stub `plan` and hand-write
      the actions, `modulePath` included, so the module address they appear to test is
      their own fixture: with every resource given a root address, all 11 pass and ten
      e2e tests fail. Rewrite them against a real `StateManager` in a temp directory, as
      `Orchestrator.spec.ts` is; what they alone pin is a missing `source`, nesting deeper
      than one level, and per-module data-source scope
- [ ] Unit tests an e2e already covers for real: `Init.spec` "should initialize state";
      `Apply.spec` `--yes`, both plan-file applies, the rejected plan file and the failed
      apply. The rest of each file pins what an e2e cannot see and stays
- [ ] `ModuleLoading.spec.ts` asserts `toHaveProperty(expectedKey)` twice in a row

## 6. Later

Ideas that need the sections above first.

- A programmatic API: `plan()`, `apply()`, `destroy()` with events, for use from a script
- Configuration in TypeScript, `clay.config.ts` with `defineConfig`, typed per provider
- Snapshots of state with rollback
- Modules from a registry or a git repository, fetched by `clay init`
- A plan as an HTML page, with the diff highlighted
- Cost estimation: a provider says what a resource costs, the plan sums the change
- A language server: completion, go to definition, hover; a VS Code extension on top
- Benchmarks on large configurations, and fuzzing the parser and the state reader

## Done

What shipped, by area. The README says how each works today.

- [x] Language: `resource`, `data`, `variable`, `output` and `module` blocks; strings,
      integers, booleans, lists and maps; references and `${...}` interpolation; comments;
      block kinds usable as attribute and map names; a duplicate block, attribute or key
      refused
- [x] Parser errors and resolve errors carry the file, line and column, the block and
      the module instance, and the CLI prints the source line with a caret
- [x] Dependency graph with cycle detection, sorted into layers; variables and outputs
      are nodes, so a value is resolved after what it reads
- [x] Planner: create, update, replace, delete and no-op from config against state;
      a value fed by a pending resource is unknown
- [x] Modules: loaded from a directory, nested, inputs from the caller, outputs to the
      caller; reaching inside one is refused
- [x] Data sources: `data` blocks read through the provider, scoped per module
- [x] State: JSON file with a serial, atomic write, backup, lock; written after every
      change; dependencies recorded so deletes run in reverse order
- [x] Saved plans: `plan --out` writes the plan with its configuration and modules;
      `apply <file>` runs it and refuses it if the state moved on
- [x] CLI: `init`, `validate`, `plan`, `apply`, `output`, `state list | show | mv | rm`
- [x] Local provider: `local_file`, `random_string`, `null_resource`, `command_exec`
- [x] Tests: unit tests per package and end-to-end tests that run the engine with the
      real provider in a temp directory; CI on every push and pull request; eslint and
      prettier on commit
