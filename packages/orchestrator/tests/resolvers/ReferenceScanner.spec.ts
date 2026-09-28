import { Address } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ReferenceScanner } from '../../src/resolvers/ReferenceScanner';

describe('ReferenceScanner', () => {
  const scanner = new ReferenceScanner();
  const context = new Address([], 'resource', 'main');
  const inModule = new Address(['app'], 'resource', 'main');

  it('should find a resource reference', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'resource', key: 'resource.dep', address: 'resource.dep' }]);
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

    expect(scanner.referencesIn(attributes, context).map((reference) => reference.key)).toEqual(['resource.dep']);
  });

  it('should find every reference in a template', () => {
    const attributes = {
      line: { type: 'Template', value: [{ type: 'Reference', value: ['resource', 'db', 'endpoint'] }, ' and ', { type: 'Reference', value: ['resource', 'kv', 'id'] }] },
    };

    expect(scanner.referencesIn(attributes, context).map((reference) => reference.key)).toEqual(['resource.db', 'resource.kv']);
  });

  it('should find no reference in a string that spells one', () => {
    const attributes = { line: { type: 'String', value: '${resource.db.endpoint}' } };

    expect(scanner.referencesIn(attributes, context)).toEqual([]);
  });

  it('should point a module reference at the output node', () => {
    const attributes = { subnet: { type: 'Reference', value: ['module', 'vpc', 'subnet_id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'output', key: 'module.vpc.outputs:subnet_id', scope: 'module.vpc', module: 'vpc', name: 'subnet_id' }]);
  });

  it('should read a reference in the scope of the module it sits in', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.referencesIn(attributes, inModule).map((reference) => reference.key)).toEqual(['module.app.resource.dep']);
  });

  it('should point a reference that reads into a value at what it names', () => {
    const attributes = {
      env: { type: 'Reference', value: ['module', 'app', 'tags', 'env'] },
      first: { type: 'Reference', value: ['resource', 'dep', 'names', 0] },
      team: { type: 'Reference', value: ['var', 'tags', 'team'] },
    };

    expect(scanner.referencesIn(attributes, context).map((reference) => reference.key)).toEqual(['module.app.outputs:tags', 'resource.dep', 'vars:tags']);
  });
});
