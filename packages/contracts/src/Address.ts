/** A number under `count`, a string under `for_each`. */
export type InstanceKey = number | string;

export function isInstanceKey(value: unknown): value is InstanceKey {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** `[0]` or `["a"]`, nothing with no key. */
export function spellKey(key: InstanceKey | undefined): string {
  return key === undefined ? '' : `[${JSON.stringify(key)}]`;
}

export interface ModuleStep {
  name: string;
  key?: InstanceKey;
}

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

function invalid(input: string): Refuse {
  return (reason) => {
    throw new Error(`Invalid address "${input}": ${reason}`);
  };
}

/** `[0]` or `["name"]`, the string JSON-quoted, so a key with a dot or a quote reads back whole and each key has one spelling. */
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

type Segment = ModuleStep;

/** The index just past the key's `]`; a quoted key may itself hold `]` or `"`. */
function keyEnd(text: string, start: number, refuse: Refuse): number {
  let at = start + 1;

  if (text[at] === '"') {
    at += 1;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
  }

  const close = text.indexOf(']', at);
  return close === -1 ? refuse(KEY_FORM) : close + 1;
}

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

function readModules(segments: Segment[], refuse: Refuse): { module: ModuleAddress; rest: Segment[] } {
  const path: ModuleStep[] = [];
  let read = 0;

  while (segments[read]?.name === 'module' && segments[read].key === undefined) {
    path.push(segments[read + 1] ?? refuse('a module needs a name after "module"'));
    read += 2;
  }

  return { module: new ModuleAddress(path), rest: segments.slice(read) };
}

/** `module.m[0].data.local_file.f`, as a plan names a data source. A caller's `refuse` says why one is not, in its own words. */
export function parseDataAddress(input: string, refuse: Refuse = invalid(input)): { module: ModuleAddress; type: string; name: string; key?: InstanceKey } {
  const { module, rest } = readModules(readSegments(input, refuse), refuse);
  const [data, type, name] = rest;

  // Only the name takes an index or a key, as `data.local_file.f[0]`.
  if (rest.length !== 3 || data.name !== 'data' || data.key !== undefined || type.key !== undefined) refuse('a data source is named data, its type and its name');

  return { module, type: type.name, name: name.name, ...(name.key !== undefined && { key: name.key }) };
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

  static of(resource: { modulePath?: readonly ModuleStep[]; resourceType: string; name: string; key?: InstanceKey }): Address {
    return new Address(new ModuleAddress(resource.modulePath || []), resource.resourceType, resource.name, resource.key);
  }

  /** Every part of the address, so a state entry or plan action built from it drops none. */
  fields(): { modulePath: readonly ModuleStep[]; resourceType: string; name: string; key?: InstanceKey } {
    return { modulePath: this.module.path, resourceType: this.resourceType, name: this.name, key: this.key };
  }

  withoutKey(): Address {
    return new Address(this.module, this.resourceType, this.name);
  }

  /**
   * Where state may hold this instance if count was added or removed on the resource or a module above it since.
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

    // The first is the instance itself.
    return found.slice(1).map((keys) => this.withKeys(keys));
  }

  /** One key per module on the path, then the resource's. */
  private withKeys(keys: (InstanceKey | undefined)[]): Address {
    const module = new ModuleAddress(this.module.path.map(({ name }, index) => (keys[index] === undefined ? { name } : { name, key: keys[index] })));
    return new Address(module, this.resourceType, this.name, keys.at(-1));
  }

  static root(resourceType: string, name: string): Address {
    return new Address(ModuleAddress.root, resourceType, name);
  }

  static parse(input: string): Address {
    const refuse = invalid(input);

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
