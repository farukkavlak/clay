import { Provisioner, Schema, types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ProvisionerRegistry } from '../../src/providers/ProvisionerRegistry';

const provisioner = (type: string, schema?: Schema): Provisioner => ({
  type,
  getSchema: async () => schema ?? { command: { type: types.string, required: true } },
  validate: async () => {},
  run: async () => {},
});

describe('ProvisionerRegistry', () => {
  it('finds a provisioner by its type', () => {
    const registry = new ProvisionerRegistry();
    const exec = provisioner('exec');
    registry.register(exec);

    expect(registry.has('exec')).toBe(true);
    expect(registry.has('other')).toBe(false);
    expect(registry.get('exec')).toBe(exec);
  });

  it('refuses a second provisioner of a type', () => {
    const registry = new ProvisionerRegistry();
    registry.register(provisioner('exec'));

    expect(() => registry.register(provisioner('exec'))).toThrow('Provisioner "exec" already registered');
  });

  it('refuses a type it has no provisioner for', () => {
    expect(() => new ProvisionerRegistry().get('exec')).toThrow('No provisioner "exec"');
  });

  it('checks the schema a provisioner gives', async () => {
    const registry = new ProvisionerRegistry();
    registry.register(provisioner('exec', { command: { type: types.string, computed: true } }));

    await expect(registry.schema('exec')).rejects.toThrow('provisioner exec gives command computed');
  });
});
