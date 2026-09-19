import { describe, expect, it } from 'vitest';

import { Address } from '../../src/Address';
import { ReferenceScanner } from '../../src/resolvers/ReferenceScanner';
import { ScopeManager } from '../../src/scope/ScopeManager';

describe('ReferenceScanner', () => {
  const scanner = new ReferenceScanner(new ScopeManager());
  const context = new Address([], 'resource', 'main');

  it('should find a resource reference', () => {
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.keysIn(attributes, context)).toEqual(['resource.dep']);
  });

  it('should ignore variables and data sources', () => {
    const attributes = {
      name: { type: 'Reference', value: ['var', 'name'] },
      image: { type: 'Reference', value: ['data', 'aws_ami', 'ubuntu', 'id'] },
    };

    expect(scanner.keysIn(attributes, context)).toEqual([]);
  });

  it('should find references inside lists', () => {
    const attributes = { ids: ['plain', { type: 'Reference', value: ['resource', 'dep', 'id'] }] };

    expect(scanner.keysIn(attributes, context)).toEqual(['resource.dep']);
  });

  it('should find every reference in an interpolated string', () => {
    // eslint-disable-next-line no-template-curly-in-string -- Mini's own interpolation syntax, not a JS template
    const value = '${resource.db.endpoint} and ${resource.kv.id}';
    const attributes = { line: { type: 'String', value } };

    expect(scanner.keysIn(attributes, context)).toEqual(['resource.db', 'resource.kv']);
  });

  it('should point a module reference at the output node', () => {
    const attributes = { subnet: { type: 'Reference', value: ['module', 'vpc', 'subnet_id'] } };

    expect(scanner.keysIn(attributes, context)).toEqual(['module.vpc.outputs.subnet_id']);
  });

  it('should read a reference in the scope of the module it sits in', () => {
    const inModule = new Address(['app'], 'resource', 'main');
    const attributes = { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } };

    expect(scanner.keysIn(attributes, inModule)).toEqual(['module.app.resource.dep']);
  });
});
