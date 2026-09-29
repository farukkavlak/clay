/** Which instance of a resource or a module: a number under `count`, a string under `for_each`. */
export type InstanceKey = number | string;

/** A key as a state or a plan file holds it: a string, or a whole number from 0. */
export function isInstanceKey(value: unknown): value is InstanceKey {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function spellKey(key: InstanceKey | undefined): string {
  return key === undefined ? '' : `[${JSON.stringify(key)}]`;
}

/** One module call on the way from the root to a resource, and which instance of it, under count or for_each. */
export interface ModuleStep {
  name: string;
  key?: InstanceKey;
}

/** A module path as a state or a plan file holds it. */
export function isModulePath(value: unknown): value is ModuleStep[] {
  return (
    Array.isArray(value) &&
    value.every((step: unknown) => {
      if (typeof step !== 'object' || step === null) return false;

      const { name, key } = step as Record<string, unknown>;
      return typeof name === 'string' && (key === undefined || isInstanceKey(key));
    })
  );
}

/** An instance of a module: the root, or the module calls that lead to it from the root. */
export class ModuleAddress {
  static readonly root = new ModuleAddress([]);

  public readonly path: readonly ModuleStep[];

  constructor(path: readonly ModuleStep[]) {
    this.path = path;
  }

  child(name: string, key?: InstanceKey): ModuleAddress {
    return new ModuleAddress([...this.path, key === undefined ? { name } : { name, key }]);
  }

  isRoot(): boolean {
    return this.path.length === 0;
  }

  /** The module as the configuration writes it, which every instance of it shares. */
  withoutKeys(): ModuleAddress {
    return new ModuleAddress(this.path.map(({ name }) => ({ name })));
  }

  /** `module.app.module.db[0]`, and nothing at the root. */
  toString(): string {
    return this.path.map((step) => `module.${step.name}${spellKey(step.key)}`).join('.');
  }
}

const KEY_FORM = 'a key is a whole number or a quoted string, as in [0] or ["name"]';

type Refuse = (reason: string) => never;

/** `[0]` or `["name"]`, the string read as JSON writes it, so a key holding a dot or a quote reads back whole; one key has one spelling. */
function readKey(text: string, refuse: Refuse): InstanceKey {
  const inner = /^\[(.*)]$/s.exec(text)?.[1] ?? refuse(KEY_FORM);

  if (/^(?:0|[1-9]\d*)$/.test(inner)) {
    const index = Number(inner);
    return Number.isSafeInteger(index) ? index : refuse(`a key is at most ${Number.MAX_SAFE_INTEGER}`);
  }

  if (!inner.startsWith('"')) refuse(KEY_FORM);

  let key: unknown;
  try {
    key = JSON.parse(inner);
  } catch (error) {
    if (error instanceof SyntaxError) refuse(KEY_FORM);

    throw error;
  }

  return JSON.stringify(key) === inner ? (key as string) : refuse(`a key is written as [${JSON.stringify(key)}]`);
}

/** A part between two dots, with the key written after it. */
type Segment = ModuleStep;

/** Where the key that opens at `start` ends, past its `]`. A quoted key may hold a `]` or a `"` of its own. */
function keyEnd(text: string, start: number, refuse: Refuse): number {
  let at = start + 1;

  if (text[at] === '"') {
    at += 1;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
  }

  const close = text.indexOf(']', at);
  return close === -1 ? refuse(KEY_FORM) : close + 1;
}

/** The segment that starts at `at`, and where the next one starts. A name never holds `.` or `[`, so either one ends it. */
function readSegment(text: string, at: number, refuse: Refuse): { segment: Segment; next: number } {
  const stop = text.slice(at).search(/[.[]/);
  const end = stop === -1 ? text.length : at + stop;
  const name = text.slice(at, end);
  if (name === '') refuse('a part of it is empty');

  if (text[end] !== '[') return { segment: { name }, next: end + 1 };

  const close = keyEnd(text, end, refuse);
  if (close < text.length && text[close] !== '.') refuse(KEY_FORM);

  return { segment: { name, key: readKey(text.slice(end, close), refuse) }, next: close + 1 };
}

function readSegments(text: string, refuse: Refuse): Segment[] {
  const segments: Segment[] = [];

  for (let at = 0; at <= text.length; ) {
    const { segment, next } = readSegment(text, at, refuse);
    segments.push(segment);
    at = next;
  }

  return segments;
}

/** The modules the segments lead through, then what is left for the type and the name. */
function readModules(segments: Segment[], refuse: Refuse): { module: ModuleAddress; rest: Segment[] } {
  const path: ModuleStep[] = [];
  let read = 0;

  while (segments[read]?.name === 'module' && segments[read].key === undefined) {
    path.push(segments[read + 1] ?? refuse('a module needs a name after "module"'));
    read += 2;
  }

  return { module: new ModuleAddress(path), rest: segments.slice(read) };
}

export class Address {
  public readonly module: ModuleAddress;
  public readonly resourceType: string;
  public readonly name: string;
  public readonly key?: InstanceKey;

  constructor(module: ModuleAddress, resourceType: string, name: string, key?: InstanceKey) {
    this.module = module;
    this.resourceType = resourceType;
    this.name = name;
    this.key = key;
  }

  /** The address of anything that names a resource: a plan action, a state entry. */
  static of(resource: { modulePath?: readonly ModuleStep[]; resourceType: string; name: string; key?: InstanceKey }): Address {
    return new Address(new ModuleAddress(resource.modulePath || []), resource.resourceType, resource.name, resource.key);
  }

  /** What a state entry or a plan action records of its address, the key with it, so no copy of the address drops a part. */
  fields(): { modulePath: readonly ModuleStep[]; resourceType: string; name: string; key?: InstanceKey } {
    return { modulePath: this.module.path, resourceType: this.resourceType, name: this.name, key: this.key };
  }

  /** The block an instance belongs to, which every instance of it shares. */
  withoutKey(): Address {
    return new Address(this.module, this.resourceType, this.name);
  }

  /**
   * Where state may keep this instance when count came or went since, on the resource or on any module on its way.
   * `a` for `a[0]`, `a[0]` for `a`, and `module.m[0].a[0]`, `module.m.a` or `module.m.a[0]` for `module.m[0].a`. `[1]` and `["x"]` have none.
   */
  countCounterparts(): Address[] {
    const own = [...this.module.path.map((step) => step.key), this.key];
    let found: (InstanceKey | undefined)[][] = [[]];

    for (const key of own)
      found = found.flatMap((keys) =>
        key === 0 || key === undefined
          ? [
              [...keys, key],
              [...keys, key === 0 ? undefined : 0],
            ]
          : [[...keys, key]]
      );

    // The first is the instance itself, with no key changed.
    return found.slice(1).map((keys) => this.withKeys(keys));
  }

  /** The same instance with these keys, one for each module on its way and the last for the resource. */
  private withKeys(keys: (InstanceKey | undefined)[]): Address {
    const module = new ModuleAddress(this.module.path.map(({ name }, index) => (keys[index] === undefined ? { name } : { name, key: keys[index] })));
    return new Address(module, this.resourceType, this.name, keys.at(-1));
  }

  static root(resourceType: string, name: string): Address {
    return new Address(ModuleAddress.root, resourceType, name);
  }

  static parse(input: string): Address {
    const refuse: Refuse = (reason) => {
      throw new Error(`Invalid address "${input}": ${reason}`);
    };

    const { module, rest } = readModules(readSegments(input, refuse), refuse);
    const [type, name] = rest;

    if (rest.length < 2) refuse('an address ends with a type and a name');
    if (type.key !== undefined) refuse('a key comes after the name');
    if (rest.length > 2) refuse(`nothing may follow the name "${name.name}"`);

    return new Address(module, type.name, name.name, name.key);
  }

  toString(): string {
    const suffix = `${this.resourceType}.${this.name}${spellKey(this.key)}`;
    return this.module.isRoot() ? suffix : `${this.module}.${suffix}`;
  }
}
