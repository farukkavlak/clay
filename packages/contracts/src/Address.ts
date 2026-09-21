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

    const modulePath: string[] = [];
    let i = 0;

    // Scan for module segments: module.<name>
    while (i < parts.length)
      if (parts[i] === 'module') {
        if (i + 1 >= parts.length) throw new Error(`Invalid address format: ${input} (incomplete module path)`);
        modulePath.push(parts[i + 1]);
        i += 2;
      } else break;

    // After scanning modules, we MUST have exactly 2 parts left: type and name
    if (i + 2 !== parts.length) throw new Error(`Invalid address format: ${input} (expected type.name at end, got ${parts.length - i} parts)`);

    const resourceType = parts[i];
    const name = parts[i + 1];

    return new Address(modulePath, resourceType, name);
  }

  toString(): string {
    const prefix = this.modulePath.map((m) => `module.${m}`).join('.');
    const suffix = `${this.resourceType}.${this.name}`;
    return prefix ? `${prefix}.${suffix}` : suffix;
  }

  equals(other: Address): boolean {
    return this.toString() === other.toString();
  }

  withParent(moduleName: string): Address {
    return new Address([moduleName, ...this.modulePath], this.resourceType, this.name);
  }
}
