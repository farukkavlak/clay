import { Provisioner, Schema } from '@clay/contracts';

import { checkProvisionerSchema } from './providerResult';

export class ProvisionerRegistry {
  private provisioners: Map<string, Provisioner> = new Map();

  register(provisioner: Provisioner): void {
    if (this.provisioners.has(provisioner.type)) throw new Error(`Provisioner "${provisioner.type}" already registered`);

    this.provisioners.set(provisioner.type, provisioner);
  }

  has(type: string): boolean {
    return this.provisioners.has(type);
  }

  get(type: string): Provisioner {
    const provisioner = this.provisioners.get(type);
    if (!provisioner) throw new Error(`No provisioner "${type}"`);

    return provisioner;
  }

  async schema(type: string): Promise<Schema> {
    return checkProvisionerSchema(type, await this.get(type).getSchema());
  }
}
