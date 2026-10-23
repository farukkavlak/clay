# Tasks

What Clay does today is in the README and `LANGUAGE.md`. This is what comes next, in the
order it is worth doing. Terraform is named where it has solved the same problem.

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
- [x] A plan that named a data source the run never read was accepted in silence. Run
      with a configuration that has no such block, or whose module makes fewer instances,
      the value the plan carried was dropped and one it left for the apply was never read.
      Now it is refused as a resource action with no block is: before anything runs when
      the block is gone, and before the block is read when only the instance is
- [x] A plan and a configuration that differed in their outputs ran in silence. With an
      output the plan showed and the configuration lacked, the run ended with no such
      output; with one the configuration had and the plan never showed, the run wrote it
      to state. Now the names are checked before anything runs. Terraform works an output
      out again at apply and compares nothing
- [x] An output whose value at apply was not the one the plan showed was written in
      silence. The names were checked, the values were not: a plan that showed
      `url = "http://x"` run with a configuration that gave `"http://y"` ended complete.
      Now each root output is held to the plan as the run reaches it, as a resource's
      values are, so one that reads nothing stops the run before anything is made.
      Terraform works an output out again at apply and compares nothing
- [x] A resource the configuration declares and the plan had no action for was skipped
      in silence: with `resource "local_file" "b"` added to the `config` in a plan file,
      `apply` said it was complete and `b` was never made. Now it is refused, as a data
      source there is, before any instance of the block runs. Terraform builds the apply
      from the plan alone and says nothing
- [x] A data address in a plan file was checked in the run, not at the file. One that
      was no address was shown by `apply` and then failed with no file named, and one in
      both `dataSources` and `readAtApply` was taken from the first and never read. Now
      the file is refused as it is read, with the address and what is wrong with it
- [x] A data source in a module that makes no instance was never read. With
      `data "local_file" "f" { path = ["x"] }` in a module called with `count = 0`,
      `clay validate` said the configuration was valid; with `count = 1` it was refused.
      Every block was read once as written but the data block. Now each of its values is
      read the same way and held to the type its schema names. Terraform validates a data
      block once the same way
- [x] `clay validate` refused a `count` or `for_each` only an apply knows, which a plan
      can accept. With the resource `local_file.size` applied and
      `count = length(data.local_file.f.content)` on a data source that reads it,
      `clay plan` made its instances and `clay validate` refused it with
      `count must be known when planning`: it plans against an empty state, where the file
      is still to be made. Now such a block makes no instance in a check, on a resource, a
      data source and a module call, and what reads it is not known yet. It is still
      checked once as written, and one whose type no apply can make right is refused:
      `count = data.local_file.f.content` is a string. A plan refuses it as before.
      Terraform's validate does not expand `count` either
- [x] An apply stopped with Ctrl-C leaves its lock, and what was running is never
      recorded. With `command = "sleep 3; touch made.txt"` and a SIGINT after a second, the
      process exits 130, `made.txt` appears, the state holds nothing and
      `clay.state.json.lock` stays, so the next apply fails on the lock and the next plan
      creates it again. Terraform starts nothing new on the first Ctrl-C, lets what runs
      finish, writes the state and unlocks. Now the first Ctrl-C starts nothing new, waits
      for what runs, saves the state, unlocks and exits 130, and a second exits at once
      and leaves the lock. `state mv` and `state rm` finish and unlock the same way
- [x] A failed apply drops every root output from state. `PlanRunner.run` deletes
      `state.outputs` before the first action and writes them only at the end, so one
      failed resource leaves `clay output` empty and the next plan shows every output as
      new. `state mv` and `state rm` drop them the same way. Terraform keeps them. Now
      the state keeps the outputs of the last finished run, and `state mv` and `state rm`
      leave them as they are
- [x] `clay apply` answered with anything but `yes`, or run with stdin closed, prints
      "Apply cancelled." and exits 0, so a pipeline without `-y` passes. Terraform exits 1.
      Now both exit 1, and closed input says to run with `--yes`
- [x] A dependency and what reads it, both replaced, are replaced one at a time: with
      `local_file.b` reading `local_file.a.id` and both paths changed, `a` is destroyed and
      made again before `b` is destroyed, so the old `b` outlives what it read. Each replace
      deletes and creates inside its own layer. Terraform destroys the dependent first.
      Now, before a replace destroys its object, what is going away and reads it, by the
      dependencies in state, is destroyed first, readers first: a replace, a delete, a
      deposed object. A replace destroyed early only creates in its own turn
- [x] A `create_before_destroy` replace whose old object reads a plain replace only in
      state outlives what it read. With `x1` using `a1`, and `a` renamed `a2` while `x`
      turns into `x2` with `create_before_destroy` and no `uses`, the apply makes `x2`, then
      fails on `a1 cannot be destroyed while x1 uses it`: the deposed `x1` waits for the
      deletes. Forced create first goes by the configuration alone. Terraform orders it by
      the dependencies in state: `x2`, then `x1` destroyed, then `a1`, then `a2`.
      Now the apply walks one graph: the configuration's, with a node for each object
      destroyed apart from its block, ordered by the dependencies in state. The deletes no
      longer wait for the end
- [x] An order that waits for itself is refused only at apply, after the plan was shown
      and approved, and with no line. Now the plan refuses it too, at the block of the
      create-first replace the loop runs through. Terraform builds the apply graph at plan
      to find such loops, and names no line
- [x] A replace destroyed before its turn is not reported when its create never runs. If
      `b1` is destroyed so that `a1` can be, and the apply then fails on `a` or is
      interrupted, the output names only `rec.a`, and nothing says `b1` is gone. The state
      is right, and the next plan shows `b` to create. A plain replace whose create fails
      did not say its old object was gone either. Now both are reported,
      `- rec.b destroyed, to be made again`. Terraform reports each half of a replace on
      its own
- [x] A resource that stays and used a plain replace only in state is updated after the
      replace destroys the old object. With `b1` holding `a1` in place, and `a` renamed
      `a2` while `b` stops holding it, `a1` and `b` run together, and a cloud refuses to
      destroy `a1` while `b1` holds it. The same holds for a delete that has to go before a
      plain replace: it does not wait for what stays and holds it. Any other delete waits.
      An order that waits for it can close a loop through the configuration. Terraform
      updates `b` after `a1` is destroyed. Now every object going away waits for what stays
      and reads it to be updated. Where what stays reads the replace that object goes
      before, no order holds both, so that wait is dropped and the apply runs as before
- [x] Renaming a resource whose new object is the old one destroys it. With
      `local_file "c" { path = "f.txt" }` renamed to `"d"`, the apply creates `d`, then deletes
      `c`, which removes `f.txt`, and says it completed. `create_before_destroy` does the
      same where the new path spells the old file another way, `./a.txt` and `a.txt`. Two
      blocks with one path write over each other. Now a provider may name the real thing
      an object is, and a plan with two objects that are one thing is refused at the
      block, a rename with the `clay state mv` that fixes it
- [x] Spelling a path another way, `./a.txt` for `a.txt`, replaces the file. With
      `create_before_destroy` the plan is refused instead. Terraform's `local_file` replaces
      it too: its `filename` is compared as written. Now a path that names the file the id
      already is updates it in place
- [x] Two objects that are one file go unseen where the path is known only at apply, as
      `path = "${random_string.x.result}.txt"`. Now the apply checks each create and update
      before the provider runs it, against what the state holds then and what the run is
      making. An object already destroyed counts no more, since it can remove nothing
- [x] Two paths that are one file through a symlink, or through case on a file system that
      ignores it, `A.txt` and `a.txt` on macOS, are taken for two files. A rename between
      them replaces the file, and with `create_before_destroy` destroys it. Now a file is
      named as the disk names it, in the case it has, through the links in its
      directories. A link at the end is a file of its own, since a delete removes the link
- [x] Two new paths that differ only in case, `new/A.txt` and `new/a.txt` where neither
      exists, are taken for two files on a file system that ignores case. Both blocks write
      the one file; the next plan refuses them, since it then exists. Now a part not made
      yet is named in one case where the nearest directory that exists ignores case, `ß`
      and `SS` as `ss`, as macOS folds them. The directory is asked by finding one of its
      names in another case, so nothing is written
- [x] A new file's name changes once it is made: in the case it was written, where before
      it was folded. At apply, two blocks in one layer whose paths differ only in case and
      are known only then can each be checked on either side of the other's create, and
      both write the one file. Now a provider gives each thing a key, the same before it is
      made and after, and a name for messages. A file's key has every part in one case
      where its directory ignores case; its name keeps the case on disk, or as written where
      not made yet
- [x] The delete order is worked out in exponential time. `reaches` in `deleteEdges` walks
      every path with no record of what it has seen, so a ladder of 56 resources that each
      read the two before takes 23 seconds to destroy, and the time doubles every two more.
      It depends on the order of keys in the state file. Now the walk records what it has
      seen, so a ladder of 200 orders at once
- [x] A plan file's action is checked only in part where the file is read. A `resourceType`
      left out is refused after "applying..." as `"undefined.a"`, a `name` of `5` is shown
      as `local_file.5` before it is refused, an attribute node of an unknown type fails as
      `Cannot read properties of undefined (reading 'kind')`, and `dependencies: [42]` is
      written to state. A schema's `sensitive` flag is not checked to be a boolean, and the
      state's `dependencies`, of a resource and of a deposed object, are not checked to be
      strings. Now each is checked where the file is read, and a dependency must be an
      address. The file no longer carries each block's expressions: the apply takes them
      from the configuration the file carries, which the parser checks, as Terraform
      evaluates its configuration snapshot
- [x] `state mv`, `state rm` and a count move rewrite the dependencies of resources and
      leave those of deposed objects naming the old address, so the delete order of that
      deposed object is lost. `mapDependencies` walks `state.resources` only. Terraform's
      `state mv` clears the dependencies of current objects and leaves deposed ones. Now
      deposed objects are rewritten too
- [x] `clay state mv` takes a destination no configuration can spell:
      `clay state mv random_string.r 'random_string.has space'` succeeds, and the next plan
      destroys it. `Address.parse` checks no name against the identifier rule. Terraform
      reads the address with the configuration's syntax. Now every address read from the
      command line, a state file or a plan file is held to the configuration's name rule,
      and so is an output name in a state file
- [x] `command_exec` quotes a sensitive value when its command fails: with
      `command = "false ${var.token}"` and `var.token` sensitive, the apply prints
      `Command failed: false s3cr3t-token`. Node's `exec` error holds the whole command.
      The engine hid a provider's message only at validate and plan. Terraform's
      `local-exec` hides the output but quotes the command in its error. Now the reason
      of every provider call given a sensitive value is hidden, at apply and refresh too
- [x] A `command_exec` whose command prints a sensitive value, `echo ${var.token}`, keeps
      it in `stdout`, which is not sensitive, so `clay state show` prints it. A value a
      provider computes was sensitive only where its schema marked it always. Terraform has
      the same gap; `local-exec` hides its output and `terraform_data` needs
      `sensitive = true`. Now a schema can mark a computed attribute sensitive with the
      attributes it is made from: `stdout` is sensitive where `command` or `cwd` is, and
      `local_file.id` where `path` is, through `ignore_changes` too
- [x] Writing out a value the provider already takes as its default replaces the resource.
      `special = false` added to a `random_string` that left it out plans a replace, since
      `special` is `forceNew` and a left-out value is not `false`. The provider contract
      has no defaults. Terraform's plugin framework has `Default`, planned where the
      configuration is null. Now a schema gives a default, and the plan holds it
- [x] `clay output --json` with no state prints a plain-text line to stdout and exits 0, so
      a script that reads it as JSON breaks. Now it prints `{}`, as an empty state does;
      Terraform does the same
- [x] `clay state rm` of an address the state does not hold exits 0, where `state show`
      exits 1. Terraform refuses it. Now it exits 1 and writes nothing
- [x] 6000 chained locals end in a stack overflow, `Maximum call stack size exceeded`,
      with no position. `Graph.findCycle` recursed, on every plan, and the check of each
      value as written read down the chain when a local came before the one it reads,
      or a block above the locals read its end.
      Now the search keeps a stack of its own, and the check reads each local after
      the ones it reads
- [x] A value nested 20000 deep ends in a stack overflow with no position,
      `Maximum call stack size exceeded`. The parser and every walk over a value recurse.
      Now the parser refuses a list, map, call, index or type nested more than 100
      levels deep, where the level one too deep starts. Terraform's HCL parser has no limit
- [x] A value nested 20000 deep in a state or plan file ends in the same stack overflow,
      in `plan` and `state show`. `JSON.parse` with a reviver recurses, from about 3000
      levels. Now a file nested more than 500 levels deep is refused before that parse;
      a file Clay writes for a value 100 deep is about 205 levels. Terraform reads its
      state with Go's `encoding/json`, which stops at 10000
- [x] A value worked out deeper than it is written ends in the same stack overflow at
      apply: 6000 locals, each a list of the one before, plan and then fail. Now a value
      or its type worked out more than 100 levels deep is refused at the expression, at
      validate and plan, before anything is written
- [x] A provider result nested more than 100 levels deep is not refused. Past 500, Clay
      writes a state it then refuses to read; at 20000 the stack overflows, and an object
      just made is lost from state. Now a value planned, read or returned more than 100
      levels deep is refused as a provider bug, and so is a schema type or default that deep. An
      object made with one is kept in state without it
- [x] The caret under an error points at the wrong column on a line indented with tabs:
      `describeError` pads with spaces under a line that keeps its tabs. A wide character,
      a combining accent or a joined emoji before the column shifts it the same way, since
      a column counts code points. Now the padding keeps the line's tabs and counts each
      character as the cells it shows in. Terraform underlines the range in the line
      instead, so its output without colour marks no column
- [x] A carriage return inside a line, not before its line feed, is printed with the source
      line under an error, so the terminal writes the rest of the line over its start. An
      escape does the same: `# \033[2J` in a comment clears the screen, and so does one in a
      module path, a provider's message or an address on the command line. Terraform prints
      the source line as it is. Now every error the CLI prints shows each control character,
      and each direction mark and control, as a character of its own one cell wide
- [x] What `plan`, `apply`, `state list`, `state show` and `output` print to stdout can
      carry a control character from outside Clay: a `for_each` key or a map key holding
      DEL, a C1 control or a direction control prints raw, since `JSON.stringify` escapes
      only C0, and so does the timestamp a plan file holds. Terraform quotes with Go's `%q`,
      which escapes them, but prints a multi-line string raw. Now a quoted value, key or
      address escapes them as `\u007f`, so `output --json` reads back as the same value;
      an address with one raw is refused, a path shows it as a character of its own, and a
      plan file's timestamp must be one Clay writes
- [ ] A choice not known at plan marks what it gives where only one side is sensitive, so
      `issensitive` answers `true` at plan and `false` at apply, and the apply fails. A
      condition and `&&` or `||` keep only the marks they have whichever way the apply goes;
      `lookup` with a key not known yet, an index not known yet, a `for` whose `if` is not
      known yet and `merge` with an argument not known yet still mark from one side
- [ ] In a module called with `count = 0`, `count = sensitive(var.n)` and
      `for_each = sensitive({ a = var.x })` pass the plan; with `count = 1` both are refused
      as sensitive. Read as written, a value with a part not known loses its marks, which
      stays needed until no choice not known at plan marks from one side
- [ ] A provider's `validate` runs only for an instance, so in a module called with
      `count = 0`, `local_file` with `path = ""` passes the plan; with `count = 1` it is
      refused: `local_file "path" must not be empty`

## 1. Language

The parser takes literals, references, function calls, for expressions, the conditional
and every operator HCL has. A real configuration hits each of these early.

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
- [x] `if` in a `for` expression. An item it leaves out is read by type only, like the result
      a condition does not pick, where Terraform does not read it at all
- [x] An index read from a value: `var.names[count.index]`, `local_file.f[each.key].content`,
      `module.app[var.i].url`. A bracket holds a reference or a call, read where the reference
      is, and it names an item of a list, a key of a map or an instance of a block. What it
      reads is a dependency. One not known yet makes the read not known yet; a sensitive one
      makes it sensitive. Terraform takes any expression; Clay has no operators yet
- [x] A variable names its type: `variable "x" { type = set(string) }`. An object given
      an attribute its type does not name is refused, where Terraform drops it in silence
- [x] `optional(type)` and `optional(type, default)` on an attribute of a variable's
      object type. One left out, or given `null`, takes its default, or `null` where it
      names none
- [x] `sensitive = true` on an output: its value is hidden in what `plan`, `apply` and
      `clay output` print, and `clay output --json` still gives it. Clay prints
      `(sensitive value)`, the stand-in its errors use; Terraform prints `<sensitive>`
      there. Both keep the flag beside the value and its type in state, where the value
      stays in plain text. A run whose configuration marks an output otherwise
      than its plan did is refused before anything runs; Terraform takes the flag from
      the configuration. One that does not fit its type is refused in one fixed
      sentence, since a key in the usual message may be the value
- [x] A sensitive value stays sensitive wherever it goes. A module's sensitive output
      marks what its caller reads, through a reference's steps, a string, a function, a
      `for`, a local, a variable and a module input, part by part: `.name` of an object
      whose `password` is sensitive is not. A set with a sensitive member is sensitive
      as a whole, and so is an object a `for` makes with a sensitive key, as in cty and
      HCL. A root output that holds one and does not say `sensitive = true` is refused,
      as in Terraform: "Output refers to sensitive values"
- [x] A `for_each` with a sensitive key is refused, since a key shows in an address: a
      value sensitive as a whole, as in Terraform, or a list with a sensitive item. A
      map with sensitive values under keys that are not is taken, and `each.value` stays
      sensitive. A sensitive `count` is refused too, since the plan shows how many
      instances it makes; Terraform accepts it, for old configurations
- [x] No error raised while a value is worked out quotes a sensitive one.
      `(sensitive value)` stands where it would be, in the key two items of a `for`
      give, where HCL quotes it, and in a string that is no number or boolean, where cty
      quotes nothing. A mismatch inside a value sensitive as a whole is told at the
      value, since its keys and how many it holds are parts of it. An output marked
      sensitive is sensitive before its type is checked, which takes the place of its
      one fixed sentence
- [x] A `for` over a collection not known yet is sensitive at plan when its key or its
      body reads a sensitive value: the plan reads both once with an item not known yet.
      `[for v in toset([random_string.r.result]) : module.db.password]` in a root output
      that is not marked is refused by the plan, where the apply refused it after
      `random_string.r` was made. HCL reads the `if` of such a for this way, and not
      its body
- [x] A `for` not known yet is sensitive as a whole only where its collection or a key
      is. Where only its body reads a sensitive value, each item is, and the size is not:
      `length` of one is taken in a root output that is not marked, and
      `for_each = { for v in ... : v => module.db.password }` is taken by `validate`,
      where a plan says it must be known. A plan file keeps this as a step that stands
      for every item, `-1`, since the items have no places yet
- [x] A key of a `for` over a collection not known yet is checked at plan, as one over
      a known collection is. `{ for v in tolist(toset([random_string.r.result])) : [v] => v }`
      is refused by `validate` and the plan, where the apply refused the key after
      `random_string.r` was made. So is one over an empty collection, or in a block that
      makes no instance, which no run refused
- [x] A `for` written as a key passes the plan while it is not known, since it has no
      type until then: `{ for v in var.l : [for c in <not known yet> : c] => v }` is
      refused only by the apply, as a tuple. Kept as it is: Terraform's `for` over a
      collection not known yet is `DynamicVal`, so it also waits for the apply.
      Refusing it at plan needs a type for "a tuple of unknown shape", which Terraform
      does not have
- [x] A resource attribute given a sensitive value is sensitive where it is read back,
      from the plan or from the state: `local_file.conf.content` in a root output that
      is not marked is refused, and so is a `for_each` given it. A plan file and the
      state keep which parts of a resource are sensitive beside its values, as
      Terraform's `sensitive_attributes` does, and the values as they are. A provider is
      sent no mark. Only what the configuration gives is marked: a value a provider
      works out from one is not
- [x] A plan whose only change is which parts of a resource are sensitive plans an
      update, and its apply writes the new marks to state without the provider. It said
      "No changes" and the state kept the old mark. Terraform plans an update too
- [x] A resource attribute given a sensitive value is hidden in the plan, under "Changed
      outside Clay" and in `clay state show`, as Terraform prints it: only the sensitive
      parts, `{"name":"app","token":(sensitive value)}`. A part sensitive on either side
      of a change is hidden on both, and a sensitive value not known yet shows as
      sensitive. A change in which parts are sensitive names each attribute it touches:
      `content: will be marked sensitive`
- [x] An error about a resource quotes no sensitive value: what the plan showed against
      what it comes to now, a provider result that is off its plan, and what a provider
      says when it refuses a configuration holding one. Terraform hides a provider result
      off its plan, has no check of the first, and leaves a provider's message as it words it
- [x] A provider's own message from a create, update, delete, refresh read or data source
      read is shown as the provider words it, and so is the message about a value it
      returns of the wrong type. The failure of a validate or a plan is hidden when a value
      in the configuration is sensitive; these are not, since an I/O error with its path is
      what a user needs to fix the run. A provider that quotes a value it was given is
      that provider's bug
- [x] A data source given a sensitive value gives it back marked at the same parts, as
      Terraform does; what the provider computes stays plain. A plan holds the parts
      of what it read, so the apply keeps them
- [x] Other places a sensitive value starts: `sensitive = true` on a variable, an
      attribute a provider's schema marks, and the functions `sensitive`, `nonsensitive`
      and `issensitive`, as Terraform has them. The schema flag marks a top-level attribute
      as a whole, null or not
- [x] A module `source` has a kind. Terraform reads a local path only when it starts with
      `./` or `../` and treats anything else as a registry address; Clay joins whatever it
      is onto the parent directory, so an absolute path is read as well
- [x] `==`, `!=`, `&&`, `||`, `!` and `a ? b : c`. Two values that can never be equal are
      refused, where Terraform says `false`. A known condition reads only the result it
      picks and the other by type, so `var.on ? local_file.f[0].path : null` takes a count
      of 0, as in Terraform
- [x] `+ - *` and `< > <= >=`, exact on numbers, where Terraform holds 512-bit binary
      floats. A string that spells a number is read as one, as in Terraform
- [x] `/` and `%`. A quotient keeps 34 significant digits, rounded half to even. Either
      one by zero is refused. Terraform gives infinity for `1 / 0`, which no state can
      hold, and the left side for `1 % 0`
- [x] Any value inside `${...}` and inside `[...]` read from a value, where only a
      reference or a call went
- [x] More functions: `upper`, `lower`, `join`, `lookup`, `merge` and `format`, beside
      `length`, `tolist`, `toset`, `sensitive`, `nonsensitive` and `issensitive`
- [x] `/* ... */` comments, which HCL reads beside `#` and `//`
- [x] `description` on a variable and an output, refused before though nearly every
      Terraform file writes it
- [x] `validation` on a variable, a condition its value must meet and the message to give
      where it does not
- [x] A validation rule that reads other variables, locals and resources, as Terraform's
      does since 1.9. The variable then depends on what its rules read
- [ ] `alltrue` and `anytrue`, and the `[*]` splat, which a rule over a list reaches for:
      `alltrue([for p in var.ports : p > 0])`, `var.servers[*].port`
- [ ] `depends_on`, for an order no reference shows. Written today, it is refused as an
      attribute the resource does not have
- [ ] A `moved` block, so a rename in the configuration moves state instead of destroying
      and creating. `clay state mv` is the only way now
- [ ] A module reads every `.clay` file in its directory, as Terraform reads every `.tf`;
      today only `main.clay`

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

A plan carries the configuration it was made from, and `apply` resolves each block's
attributes again from it. Terraform's apply evaluates the configuration again too, since a value only an
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
- [x] A value not known yet is refused at plan where its type can never be joined into
      a string (`"x-${thing.a.tags}"` with `tags` a map) or be an index
      (`names[thing.a.tags]`). The plan passed and the apply failed after `thing.a` was
      made. A sensitive one is refused without its type. Terraform also waits for the apply
- [x] A step into a value not known yet is refused at plan where its type can never take
      it: an index into a set or a map, a key into a list, a name its object type does not
      have, any step into a string. `random_string.r.result.nope` is refused by `validate`
      and the plan, where the apply refused it after `random_string.r` was made, and a
      block with `count = 0` never. So is `data.local_file.f.content.nope`, which
      `validate` let through. Terraform refuses at plan: "Can't access attributes on a
      primitive-typed value (string)"
- [x] A step into an output of a module whose `count` is not known yet is not checked:
      `module.m[0].x.nope` is valid to `clay validate`, since the output has no type until
      the module has instances. Resources and data sources give an unknown of their schema
      type there and are refused. Left as it is: the plan refuses a `count` not known yet,
      so no plan or apply gets past it, and `validate` refuses the step once `count` is
      known. Terraform checks the step only where every output of the module declares its
      type, and not at all for an output without one
- [x] The body of a `for` over a collection known to be empty is read against its item
      type. `[for log in local_file.logs : log.contnet]` is refused with `count = 0` or
      `for_each = {}`, as with `count = 2`, and so is a body over an empty `list(string)`
      or `map(object(...))` variable. A body over a literal `[]` is not, since an empty
      tuple names no item type. HCL does not read it either, so that is not a gap
- [x] A value not known yet is checked by its whole type, not only its own kind. A list of
      numbers only the apply knows, `tolist(toset([length(random_string.r.result)]))`,
      given to a variable of type `list(bool)` was valid to the plan and refused by the
      apply after `random_string.r` was made. Its items, tuple places, object attributes and
      tuple length are checked now, as Terraform's type conversion does; a string not
      known yet still passes as a boolean or a number, since it may spell one
- [x] A provider that says it computes a value and does not return it at apply leaves it
      `null`, and what requires it said only `local_file requires "content"`. It names
      the reference now, for a resource at the plan and the apply and for a data source at
      the plan:
      `local_file requires "content", and stamp.a.made, which it reads, is null`. The
      value stays null and is not refused as the provider's bug, since a null may be right
      for an instance; Terraform also lets a value not known at plan come to null
- [x] A null a reference gives is named where a whole required attribute, a `count` or a
      `for_each` is null: `count` says `not null, and var.k, which it reads, is null`.
      Terraform names the expression only, by its position
- [x] A null a reference gives is named where a `for` goes over it, as the key of a `for`,
      as a function argument and as an index, the way `count` does it. Joining it into a
      string already names it
- [x] A null a reference gives is not named where it makes a nested attribute required
      or a variable of another type refuse it, because neither is refused. `null` is a
      value of every type, so an object attribute its type requires may be `null`, and a
      required attribute of a schema may not: that is a promise to the provider, which gets
      no value for it. A variable refuses a value of the wrong type, and null is not one.
      Terraform: its core checks that a required attribute is present, not that it is not
      null, at the top and inside an object alike

### Data sources in the graph

Data sources were read while the config loaded, before any resource existed and before any
module output had a value, so one that read either failed at plan.

- [x] Data sources are graph nodes, read in dependency order and once per run. Read at load,
      one whose input read a resource the plan changed got the value in state, while a
      resource that read it got the value the plan set. One that read every instance of
      a resource with `count` or `for_each`, `local_file.logs`, was refused, since no count
      was read yet. Now each is read after what it reads
- [x] A data source in a module called with `count` or `for_each` is read once for each
      instance of its module. It was refused, since it was one node, read once. Each
      instance waits for the apply on its own, as in Terraform, so one whose resources stay
      as they are is read at plan while another waits
- [x] `count` on a data source, as on a resource. `data.local_file.f[0]` is one instance,
      `data.local_file.f` alone the list of them, and a plan names each by its index. The
      apply reads the count again and refuses an index the plan has and the count does not
- [x] `for_each` on a data source, as on a resource. `data.local_file.f["a"]` is one
      instance, `data.local_file.f` alone the map of them by key, and `each.key` and
      `each.value` are read in its block
- [x] A data source fed by a pending resource is `(known after apply)`. It waits for the
      apply when what it reads is not known yet, or when it reads a resource the plan
      changes, through variables and module outputs too, so it never reads the world
      before the apply. The plan shows `<= data.x.y will be read during apply`. Terraform
      waits only for a resource read directly, so a local in between reads the old value
- [x] Their values travel in the plan, as in Terraform, so `apply` reads none the plan
      read again. `runPlan` still parses and builds the graph on its own, since a saved plan
      brings its own configuration
- [x] `local_file` as a data source reads the file
- [x] `clay validate` reads none. It asked the provider for real data, so checking a
      configuration needed whatever the data source talks to, and a file not there yet
      made it invalid. Now each one is checked as written and by its provider, and what
      it reads is not known yet, of the type its schema names. A data source that waits
      for the apply is checked by its provider at plan too. Terraform's validate calls the
      provider's check and reads nothing
- [x] `locals { name = "${var.prefix}-x" }`: a value a module works out once and reads by
      name as `local.name`. A variable default is a constant, so such a value was written
      out again wherever it was read. A local is a node worked out once for each module
      instance, so a data source can read it, and one that reads a pending resource through
      it waits for the apply. It names no type: `clay validate` reads its value as written
      and knows the type from that, as Terraform does

### Parallel apply

The graph sorts into layers, and the runner takes one layer at a time, running what is
in it together.

- [x] A run carries its own scopes, instances and data-source values. The engine held one
      of each and cleared them on load, so a plan made while an apply was half way gave
      the apply the values of its own configuration: it stopped with "the plan showed
      ... but it now comes to ..." after some resources were made. Every plan, validate
      and apply now builds its own. Terraform builds a walker for each operation too
- [x] Resources in one layer run together, ten at a time, and so do the deletes of one
      layer. State is still written after every action, as Terraform updates its state
      after every resource; writes go one at a time. When an action fails, the ones
      running finish and are saved, none starts, and the failure comes last, since the
      CLI stops reading at it
- [x] `--parallelism <n>` on `apply` for how many actions run at once, ten if not given,
      with a saved plan too, since a plan does not hold it. A value that is not a whole
      number from 1 is refused by the flag and by the engine; Terraform refuses a negative
      one and takes 0 as 10, which Clay does not
- [x] Every failure of a run is reported. `apply` collects the failures of a run: one is
      the error as before, several are listed and counted, and a crash after them still
      shows them first

### Performance

Measured with the local provider; a remote provider makes the sequential calls cost more.

- [ ] An apply writes the whole state, and copies the last one to `.bak`, after every
      action, so its cost grows with the square of the resources: 1000 independent
      resources take 2 seconds, 4000 take 16 to 31. Terraform updates the state in memory
      after each resource and persists it at intervals
- [ ] Each instance records every instance of each block it reads as a dependency: with
      `count = n` and `null_resource.a[count.index]`, `b[5]` lists all `n` of `a`. At 1000
      the state is 32 MB and the apply takes two minutes. Terraform keeps dependencies by
      block
- [ ] The apply runs layer by layer, so one slow resource holds back every resource of the
      next layer, and one failure stops branches that do not read it. A `sleep 3` beside a
      chain of three `sleep 1` takes 5 seconds where 3 would do. Terraform walks the graph,
      and skips only what reads a failed resource. Once the graph is walked, a root output
      can be written when it resolves, so a failure leaves only the outputs that read it
      at their old value, as Terraform does
- [ ] Refresh, planning, schema loading and data source reads call the provider one at a
      time. With 100 ms a call, 20 resources plan in 4 seconds. Terraform runs them as the
      graph allows, ten at a time
- [x] `Graph.dependenciesOf` scans every node's edges on each call, and the plan calls it for
      every resource, so a plan of 4000 blocks spends 1.8 of its 2.4 seconds there. The graph
      can keep the reverse edges

### Lifecycle

- [x] Deposed objects: state holds the earlier objects of a resource that a replace has not
      destroyed, by address and apart from `resources`, so a resource the provider no longer
      finds, or the configuration drops, does not take them with it. A plan destroys them as
      a delete of their own; `state list`, `show`, `mv` and `rm` know them
- [x] `lifecycle { create_before_destroy = true }`: a replace creates the new object first
      and leaves the old one deposed, destroyed with the deletes once what read it is
      updated. The flag reaches every resource the flagged one reads, as in Terraform
      (`ForcedCBDTransformer`). A failed create leaves the old object whole
- [x] `lifecycle { prevent_destroy = true }`: the plan refuses to replace the resource, and
      to delete it. The state keeps the flag of the last apply, so a delete is judged by
      it once the block is gone; a replace goes by the block. Terraform judges by the block
      alone, so a resource whose block is gone is deleted
- [x] `lifecycle { ignore_changes = [...] }`: named attributes, or `all`, do not count as a
      change. A path may reach a map key or a list index. The configuration is read as the
      state holds those paths before the provider plans, as Terraform does, so the plan,
      the readers of the attribute and the apply all see the old value. A change made outside
      Clay still shows as drift

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

### Safety

- [ ] `.bak` is the write before the last one, not the state before the run: after an apply
      of three resources the state is serial 4 and `.bak` serial 3, with all three in it, so
      it cannot undo the run. Terraform writes its backup once a run
- [ ] An apply takes the lock after it has refreshed, planned and been answered `yes`, so
      a second apply asks its question and then fails on the lock. A plan never looks at the
      lock. The lock file holds a time and no process or host, so a stale one cannot be told
      from a live one
- [ ] The state is renamed into place without an fsync, so a power loss may leave it
      empty on a file system that reorders writes

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
- [ ] `clay destroy`, and `plan -destroy`: today the only way to remove everything is to
      empty `main.clay`
- [ ] A root variable takes a value from outside the configuration: `-var`, a variables
      file and the environment. Today one with no default is refused even by `validate`
- [ ] `plan -detailed-exitcode`, so a script can tell no changes from changes; `plan` exits
      0 either way
- [ ] The plan lists what a resource to create holds, and names the attribute that forces a
      replace, so the values can be read before answering `yes`

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
- [ ] `local_file` takes two paths for two files in rare file system corners. An empty
      volume mounted under a directory with the other case rule is judged by that
      directory. `é` as one character and as `e` with an accent are two names, though
      macOS keeps them as one. A link that points nowhere is named as written. Each needs
      code that only this provider uses, so it waits until a user meets it

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
      So do `readData`, which reads a data source at apply, `readKeys`, which reads a
      `count` or a `for_each` again at apply, `expandCall`, which reads a module's `count`
      or `for_each` again, the refusal of a saved plan's action in an instance of a module
      the configuration does not make, the refusal of an output that is not what the plan
      showed, and a local worked out again at apply
- [x] An output may be named `__proto__`. The plan and the apply collected root outputs
      into a plain object, where that name sets a prototype instead of a key, so the plan
      never held it and the apply refused it. Both collect them in a map now, as a module's
      outputs already were
- [ ] A word after a command that takes none is ignored: `clay output nope` prints every
      output and exits 0, and so do `validate`, `plan`, `init` and `state list` with one.
      Commander takes extra arguments unless told not to
- [ ] Error messages are written three ways: the parser's `Expect '}' after block body.`,
      `Module "m" is missing a valid "source" attribute.` beside `module "m" has source ...`,
      and engine wording that reaches the user,
      `Data source "x" not found (or not resolved yet)` and
      `Invalid resource reference ...: Resource ... not found in state`
- [ ] A parse error names no block: a bad attribute in a variable prints `on main.clay line 3:`
      where a resolve error adds `, in variable "region"`
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
- [ ] `Graph.getNode` is followed by `!` at six call sites; the graph should hand back a
      node or say it has none
- [ ] `ModuleLoader.loadModuleTree` is `async` with nothing to await, and walks the same
      statements as `loadChildModule` does
- [ ] The root address is spelled three ways
- [ ] `PlanRunner` reads `?.dependencies ?? []`, which reads a missing state entry as one
      with no dependencies
- [ ] The CLI rebuilds the module file layout that `RecordingFiles` already snapshotted
- [ ] A `state show` test feeds a resource with no `attributes`, which `parseState` now
      refuses to read; the branch it covers may be unreachable
- [x] `ActionExecutor.executeUpdate` says "the plan resolved these against an older
      state", but `action.attributes` is the parsed block and was never resolved;
      `executeCreate` does the same resolve with no comment
- [ ] `LoadedResource.uniqueId` is `address.toString()` under a second name
- [ ] The type of an object type is spelled out three times in the orchestrator, in
      `withLeftOut.ts`, `declared.ts` and `unify.ts`
- [x] Comments that restate the code: the `// e.g., "my_file"` trailers in `ast.ts`, the
      `// {` and `// }` trailers in `tokens.ts`, the `forceNew` explanations in the local
      provider

- [ ] Plan and apply walk the graph in two classes that repeat each other: `DesiredStateBuilder`
      and `PlanRunner` each read count and for_each, make data source instances, resolve
      their inputs, expand module calls and work out locals and outputs, so a fix to one
      has to be made in both
- [ ] A value not known yet travels two ways: as `UNKNOWN` inside the data, and as a thrown
      `UnresolvedReferenceError` that six places catch and turn back into a value. Whether an
      unknown is an error also hangs on `Planned.begin()`, a mode that is never reset
- [ ] `ReferenceResolver` builds its own resolvers instead of taking them in its
      constructor, and `DesiredStateBuilder` and `ConfigLoader` take ten collaborators each,
      most of them maps every component writes to
- [ ] `tryAt`, `withPlace`, `hidingReason` and the refresh's `readBack` catch every error, so
      a `TypeError` in the engine is reported as a mistake in the configuration, or hidden
      as "failed on its configuration"
- [x] A saved plan holds each action's parsed attributes and the configuration's text, and
      the apply resolves the first while it builds the graph from the second. Now it holds
      the text only, and the apply resolves each block from it
- [ ] `planner/src/index.ts` holds the plan file, the diff, the plan and apply checks and
      `plan()` in one file of 700 lines
- [ ] Workspace packages are not `"private": true`, so `npm publish -ws` would publish them;
      four of eight have a `lint` script
- [ ] CI runs Node 22.13 only, the lowest `engines` allows, and not the newest

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
- [ ] `ApplyPlan.spec.ts` says the CLI parses on import, so its tests drive the
      orchestrator, and ten other specs in the same folder run the CLI
- [ ] `Graph.spec.ts` asserts the flattened list of a simple sort, `sorted.flat()`, where
      the layers are deterministic and should be asserted
- [ ] Regression tests explain what used to happen; a comment says what the test pins
- [x] Test comments of the `// Setup`, `// Verify`, `// Mock X` kind restate the line
      below them, across `Orchestrator.spec.ts`, `StateManager.spec.ts`, `Graph.spec.ts`
      and others
- [x] No test puts a reference inside a list: `tags = [local_file.a.id]`. With
      `resolveList` passing a `Reference` node through unresolved, all 452 tests pass
- [ ] No test has a delete fail. The `failed` event, the kept state entry and the
      released lock on that path are unpinned. A replace whose create fails after the
      delete is untested the same way
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
- [ ] `toBeDefined()` alone pins nothing in `State.spec.ts`, `StateCommands.spec.ts`,
      `DataSources.spec.ts`, `ModuleDataFlow.spec.ts`, `Planner.spec.ts` and
      `LocalProvider.spec.ts`
- [ ] 52 of the 82 e2e specs define the same `newOrchestrator` and register the local
      provider themselves; only `start.ts` is shared
- [ ] Each package's coverage counts what its tests import from other packages, so
      `contracts` shows 64% with code the e2e tests cover. CI holds no threshold
- [ ] Old test titles read `should ...` beside the plain sentences of the rest

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

What shipped, by area. The README and `LANGUAGE.md` say how each works today.

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
