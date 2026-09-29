import { Address, ModuleAddress } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { Reference, ReferenceScanner } from '../../src/resolvers/ReferenceScanner';

const keysOf = (references: Reference[]) => references.map((reference) => (reference.kind === 'count' || reference.kind === 'each' ? reference.kind : reference.key));

describe('ReferenceScanner', () => {
  const scanner = new ReferenceScanner(new Instances());
  const context = Address.root('resource', 'main');
  const inModule = new Address(ModuleAddress.root.child('app'), 'resource', 'main');

  it('should find a resource reference', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([
      {
        kind: 'resource',
        key: 'resource.dep',
        block: 'resource.dep',
        address: 'resource.dep',
        reference: { kind: 'resource', type: 'resource', name: 'dep', path: ['id'] },
      },
    ]);
  });

  // The graph holds the block once for every instance of its module; the plan reads the one in the instance it is in.
  it('keys a resource read in an instance of a module by its block, and names the block and the instance in that instance of the module', () => {
    const instances = new Instances();
    instances.declare('module.app.resource.dep', 'count');
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    const [found] = new ReferenceScanner(instances).referencesIn({ type: 'Reference', value: ['resource', 'dep', 1, 'id'] }, inInstance);

    expect(found).toMatchObject({ key: 'module.app.resource.dep', block: 'module.app[0].resource.dep', address: 'module.app[0].resource.dep[1]' });
  });

  it('keys a variable read in an instance of a module in that instance', () => {
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    expect(keysOf(scanner.referencesIn({ type: 'Reference', value: ['var', 'x'] }, inInstance))).toEqual(['module.app[0].vars:x']);
  });

  // The graph has one node for the output, shared by every instance of its module; the plan reads the output of the instance the index names, in the instance it is read in.
  it('keys an output read in an instance of a module by its node, and names the output of the instance read and the call that makes it', () => {
    const inInstance = new Address(ModuleAddress.root.child('app', 0), 'resource', 'main');

    const [found] = scanner.referencesIn({ type: 'Reference', value: ['module', 'db', 2, 'url'] }, inInstance);

    expect(found).toMatchObject({
      key: 'module.app.module.db.outputs:url',
      address: 'module.app[0].module.db[2].outputs:url',
      call: ModuleAddress.root.child('app', 0).child('db'),
      index: 2,
    });
  });

  it('should ignore data sources', () => {
    const attributes = { image: { type: 'Reference', value: ['data', 'aws_ami', 'ubuntu', 'id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([]);
  });

  it('should point a variable reference at the variable node', () => {
    const attributes = { name: { type: 'Reference', value: ['var', 'name'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'variable', key: 'vars:name', name: 'name' }]);
  });

  it('should read a variable in the scope of the module it sits in', () => {
    const attributes = { name: { type: 'Reference', value: ['var', 'name'] } };

    expect(scanner.referencesIn(attributes, inModule)).toEqual([{ kind: 'variable', key: 'module.app.vars:name', name: 'name' }]);
  });

  it('should find references inside lists', () => {
    const attributes = { ids: ['plain', { type: 'Reference', value: ['resource', 'dep', 'id'] }] };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['resource.dep']);
  });

  it('should find every reference in a template', () => {
    const attributes = {
      line: { type: 'Template', value: [{ type: 'Reference', value: ['resource', 'db', 'endpoint'] }, ' and ', { type: 'Reference', value: ['resource', 'kv', 'id'] }] },
    };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['resource.db', 'resource.kv']);
  });

  it('should find no reference in a string that spells one', () => {
    const attributes = { line: { type: 'String', value: '${resource.db.endpoint}' } };

    expect(scanner.referencesIn(attributes, context)).toEqual([]);
  });

  it('should point a module reference at the output node', () => {
    const attributes = { subnet: { type: 'Reference', value: ['module', 'vpc', 'subnet_id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([
      {
        kind: 'output',
        key: 'module.vpc.outputs:subnet_id',
        address: 'module.vpc.outputs:subnet_id',
        call: ModuleAddress.root.child('vpc'),
        scope: 'module.vpc',
        module: 'vpc',
        name: 'subnet_id',
        reference: { kind: 'module', module: 'vpc', path: ['subnet_id'] },
      },
    ]);
  });

  it('should read a reference in the scope of the module it sits in', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(keysOf(scanner.referencesIn(attributes, inModule))).toEqual(['module.app.resource.dep']);
  });

  it('should point a reference that reads into a value at what it names', () => {
    const attributes = {
      env: { type: 'Reference', value: ['module', 'app', 'tags', 'env'] },
      first: { type: 'Reference', value: ['resource', 'dep', 'names', 0] },
      team: { type: 'Reference', value: ['var', 'tags', 'team'] },
    };

    expect(keysOf(scanner.referencesIn(attributes, context))).toEqual(['module.app.outputs:tags', 'resource.dep', 'vars:tags']);
  });
});
