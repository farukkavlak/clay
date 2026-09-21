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

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'variable', key: 'vars.name', name: 'name' }]);
  });

  it('should read a variable in the scope of the module it sits in', () => {
    const attributes = { name: { type: 'Reference', value: ['var', 'name'] } };

    expect(scanner.referencesIn(attributes, inModule)).toEqual([{ kind: 'variable', key: 'module.app.vars.name', name: 'name' }]);
  });

  it('should find references inside lists', () => {
    const attributes = { ids: ['plain', { type: 'Reference', value: ['resource', 'dep', 'id'] }] };

    expect(scanner.referencesIn(attributes, context).map((reference) => reference.key)).toEqual(['resource.dep']);
  });

  it('should find every reference in an interpolated string', () => {
    const value = '${resource.db.endpoint} and ${resource.kv.id}';
    const attributes = { line: { type: 'String', value } };

    expect(scanner.referencesIn(attributes, context).map((reference) => reference.key)).toEqual(['resource.db', 'resource.kv']);
  });

  it('should point a module reference at the output node', () => {
    const attributes = { subnet: { type: 'Reference', value: ['module', 'vpc', 'subnet_id'] } };

    expect(scanner.referencesIn(attributes, context)).toEqual([{ kind: 'output', key: 'module.vpc.outputs.subnet_id', scope: 'module.vpc', module: 'vpc', name: 'subnet_id' }]);
  });

  it('should read a reference in the scope of the module it sits in', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.referencesIn(attributes, inModule).map((reference) => reference.key)).toEqual(['module.app.resource.dep']);
  });

  it('should reject a reference that reaches into a module', () => {
    const attributes = { id: { type: 'Reference', value: ['module', 'app', 'local_file', 'a', 'content'] } };

    expect(() => scanner.referencesIn(attributes, context)).toThrow('Reference "module.app.local_file.a.content" reaches into a module; modules are read through their outputs');
  });
});
