export class Address {
  public readonly modulePath: string[];
  public readonly resourceType: string;
  public readonly name: string;

  constructor(modulePath: string[], resourceType: string, name: string) {
    this.modulePath = modulePath;
    this.resourceType = resourceType;
    this.name = name;
  }

  /** The address of anything that names a resource: a plan action, a state entry. */
  static of(resource: { modulePath?: string[]; resourceType: string; name: string }): Address {
    return new Address(resource.modulePath || [], resource.resourceType, resource.name);
  }

  static root(resourceType: string, name: string): Address {
    return new Address([], resourceType, name);
  }

  static parse(input: string): Address {
    const parts = input.split('.');
    const refuse = (reason: string): never => {
      throw new Error(`Invalid address "${input}": ${reason}`);
    };

    if (parts.includes('')) refuse('a part of it is empty');

    const modulePath: string[] = [];
    let read = 0;

    while (parts[read] === 'module') {
      if (read + 1 >= parts.length) refuse('a module needs a name after "module"');

      modulePath.push(parts[read + 1]);
      read += 2;
    }

    const rest = parts.slice(read);
    if (rest.length < 2) refuse('an address ends with a type and a name');
    if (rest.length > 2) refuse(`nothing may follow the name "${rest[1]}"`);

    return new Address(modulePath, rest[0], rest[1]);
  }

  toString(): string {
    const prefix = this.modulePath.map((m) => `module.${m}`).join('.');
    const suffix = `${this.resourceType}.${this.name}`;
    return prefix ? `${prefix}.${suffix}` : suffix;
  }
}
