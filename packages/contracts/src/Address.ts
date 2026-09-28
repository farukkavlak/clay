/** Which instance of a resource: a number under `count`, a string under `for_each`. */
export type InstanceKey = number | string;

/** A key as a state or a plan file holds it: a string, or a whole number from 0. */
export function isInstanceKey(value: unknown): value is InstanceKey {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
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

/** The module path, then what is left for the type and the name. */
function readModules(head: string, refuse: Refuse): { modulePath: string[]; rest: string[] } {
  const parts = head.split('.');
  if (parts.includes('')) refuse('a part of it is empty');

  const modulePath: string[] = [];
  let read = 0;

  while (parts[read] === 'module') {
    if (read + 1 >= parts.length) refuse('a module needs a name after "module"');

    modulePath.push(parts[read + 1]);
    read += 2;
  }

  return { modulePath, rest: parts.slice(read) };
}

export class Address {
  public readonly modulePath: string[];
  public readonly resourceType: string;
  public readonly name: string;
  public readonly key?: InstanceKey;

  constructor(modulePath: string[], resourceType: string, name: string, key?: InstanceKey) {
    this.modulePath = modulePath;
    this.resourceType = resourceType;
    this.name = name;
    this.key = key;
  }

  /** The address of anything that names a resource: a plan action, a state entry. */
  static of(resource: { modulePath?: string[]; resourceType: string; name: string; key?: InstanceKey }): Address {
    return new Address(resource.modulePath || [], resource.resourceType, resource.name, resource.key);
  }

  /** What a state entry or a plan action records of its address, the key with it, so no copy of the address drops a part. */
  fields(): { modulePath: string[]; resourceType: string; name: string; key?: InstanceKey } {
    return { modulePath: this.modulePath, resourceType: this.resourceType, name: this.name, key: this.key };
  }

  /** The block an instance belongs to, which every instance of it shares. */
  withoutKey(): Address {
    return new Address(this.modulePath, this.resourceType, this.name);
  }

  /** Where state keeps this instance when count came or went since: `a` for `a[0]`, and `a[0]` for `a`. Any other instance has no such place. */
  countCounterpart(): Address | undefined {
    if (this.key === 0) return this.withoutKey();
    if (this.key === undefined) return new Address(this.modulePath, this.resourceType, this.name, 0);

    return undefined;
  }

  static root(resourceType: string, name: string): Address {
    return new Address([], resourceType, name);
  }

  /** A name never holds `[`, so the first one starts the key. */
  static parse(input: string): Address {
    const refuse: Refuse = (reason) => {
      throw new Error(`Invalid address "${input}": ${reason}`);
    };

    const bracket = input.indexOf('[');
    const { modulePath, rest } = readModules(bracket === -1 ? input : input.slice(0, bracket), refuse);

    if (bracket !== -1 && rest.length === 0 && modulePath.length > 0) refuse('a module has no instances, so it takes no key');
    if (bracket !== -1 && rest.length === 1) refuse('a key comes after the name');
    if (rest.length < 2) refuse('an address ends with a type and a name');
    if (rest.length > 2) refuse(`nothing may follow the name "${rest[1]}"`);

    return new Address(modulePath, rest[0], rest[1], bracket === -1 ? undefined : readKey(input.slice(bracket), refuse));
  }

  toString(): string {
    const prefix = this.modulePath.map((m) => `module.${m}`).join('.');
    const key = this.key === undefined ? '' : `[${JSON.stringify(this.key)}]`;
    const suffix = `${this.resourceType}.${this.name}${key}`;
    return prefix ? `${prefix}.${suffix}` : suffix;
  }
}
