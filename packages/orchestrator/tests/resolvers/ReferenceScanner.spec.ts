import { Address, ModuleAddress } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ModuleInstances } from '../../src/ModuleInstances';
import { Reference, ReferenceScanner } from '../../src/resolvers/ReferenceScanner';
import { steps } from '../ast';

const keysOf = (references: Reference[]) => references.map((reference) => (reference.kind === 'count' || reference.kind === 'each' ? reference.kind : reference.key));

describe('ReferenceScanner', () => {
  const scanner = new ReferenceScanner(new ModuleInstances());
  const context = Address.root('resource', 'main');
  const inModule = new Address(ModuleAddress.root.child('app'), 'resource', 'main');

  it('should find a resource reference', () => {
    const attributes = { id: { type: 'Reference', value: steps('resource', 'dep', 'id') } };

    expect(scanner.referencesIn(attributes, context)).toEqual([
      {
        kind: 'resource',
        key: 'resource.dep',
        block: 'resource.dep',
        reference: { kind: 'resource', type: 'resource', name: 'dep', path: steps('id') },
      },
    ]);
  });

  // The graph holds the block once for all module instances; the plan reads the one in its own instance.
  it('keys a resource read in an instance of a module by its block, and names that block in the instance', () => {
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    const [found] = scanner.referencesIn({ type: 'Reference', value: steps('resource', 'dep', 1, 'id') }, inInstance);

    expect(found).toMatchObject({ key: 'module.app.resource.dep', block: 'module.app[0].resource.dep' });
  });

  it('keys a variable read in an instance of a module in that instance', () => {
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    expect(keysOf(scanner.referencesIn({ type: 'Reference', value: steps('var', 'x') }, inInstance))).toEqual(['module.app[0].vars:x']);
  });

  // One graph node per output, shared by all instances; the plan reads the instance the index names.
  it('keys an output read in an instance of a module by its node, and names the output of the instance read and the call that makes it', () => {
    const modules = new ModuleInstances();
    modules.declare(ModuleAddress.root.child('app').child('db'), 'count');
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    const [found] = new ReferenceScanner(modules).referencesIn({ type: 'Reference', value: steps('module', 'db', 2, 'url') }, inInstance);

    expect(found).toMatchObject({
      key: 'module.app.module.db.outputs:url',
      call: ModuleAddress.root.child('app', 0).child('db'),
      instanceKey: 2,
    });
  });

  it('reads the first step of a module called with for_each as its key when it is in brackets', () => {
    const modules = new ModuleInstances();
    modules.declare(ModuleAddress.root.child('db'), 'for_each');

    const [found] = new ReferenceScanner(modules).referencesIn({ type: 'Reference', value: steps('module', 'db', { key: 'eu' }, 'url') }, context);

    expect(found).toMatchObject({ key: 'module.db.outputs:url', instanceKey: 'eu', name: 'url' });
  });

  it('reads a name after a dot as the output, never as the key of a module called with for_each', () => {
    const modules = new ModuleInstances();
    modules.declare(ModuleAddress.root.child('db'), 'for_each');

    const [found] = new ReferenceScanner(modules).referencesIn({ type: 'Reference', value: steps('module', 'db', 'eu', 'url') }, context);

    expect(found).toMatchObject({ key: 'module.db.outputs:eu', name: 'eu' });
    expect(found).not.toHaveProperty('instanceKey');
  });

  it('points a data source reference at the data source node, apart from a resource of the same type and name', () => {
    const attributes = { image: { type: 'Reference', value: steps('data', 'aws_ami', 'ubuntu', 'id') } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'data', key: 'data:aws_ami.ubuntu', name: 'data.aws_ami.ubuntu' }]);
  });

  it('should point a variable reference at the variable node', () => {
    const attributes = { name: { type: 'Reference', value: steps('var', 'name') } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'variable', key: 'vars:name', name: 'name' }]);
  });

  it('should read a variable in the scope of the module it sits in', () => {
    const attributes = { name: { type: 'Reference', value: steps('var', 'name') } };

    expect(scanner.referencesIn(attributes, inModule)).toEqual([{ kind: 'variable', key: 'module.app.vars:name', name: 'name' }]);
  });

  it('should find references inside lists', () => {
    const attributes = { ids: ['plain', { type: 'Reference', value: steps('resource', 'dep', 'id') }] };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['resource.dep']);
  });

  it('should find every reference in a template', () => {
    const attributes = {
      line: { type: 'Template', value: [{ type: 'Reference', value: steps('resource', 'db', 'endpoint') }, ' and ', { type: 'Reference', value: steps('resource', 'kv', 'id') }] },
    };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['resource.db', 'resource.kv']);
  });

  it('should find no reference in a string that spells one', () => {
    const attributes = { line: { type: 'String', value: '${resource.db.endpoint}' } };

    expect(scanner.referencesIn(attributes, context)).toEqual([]);
  });

  it('should point a module reference at the output node', () => {
    const attributes = { subnet: { type: 'Reference', value: steps('module', 'vpc', 'subnet_id') } };

    expect(scanner.referencesIn(attributes, context)).toEqual([
      {
        kind: 'output',
        key: 'module.vpc.outputs:subnet_id',
        call: ModuleAddress.root.child('vpc'),
        scope: 'module.vpc',
        module: 'vpc',
        name: 'subnet_id',
        reference: { kind: 'module', module: 'vpc', path: steps('subnet_id') },
      },
    ]);
  });

  it('should read a reference in the scope of the module it sits in', () => {
    const attributes = { id: { type: 'Reference', value: steps('resource', 'dep', 'id') } };

    expect(keysOf(scanner.referencesIn(attributes, inModule))).toEqual(['module.app.resource.dep']);
  });

  it('should point a reference that reads into a value at what it names', () => {
    const attributes = {
      env: { type: 'Reference', value: steps('module', 'app', 'tags', 'env') },
      first: { type: 'Reference', value: steps('resource', 'dep', 'names', 0) },
      team: { type: 'Reference', value: steps('var', 'tags', 'team') },
    };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['module.app.outputs:tags', 'resource.dep', 'vars:tags']);
  });
});
