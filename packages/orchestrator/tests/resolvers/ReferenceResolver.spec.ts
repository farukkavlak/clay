import { Address, ExactNumber, ModuleAddress, State, STATE_VERSION, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, ConfigError, TemplatePart } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { ModuleInstances } from '../../src/ModuleInstances';
import { Planned } from '../../src/Planned';
import { ReferenceResolver } from '../../src/resolvers/ReferenceResolver';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { Value, valueOf } from '../../src/Value';
import { ref, str } from '../ast';

const position = { file: 'main.clay', line: 1, column: 1 };
const num = (text: string): AttributeValue => ({ type: 'Number', value: ExactNumber.parse(text), position });
const list = (...value: AttributeValue[]): AttributeValue => ({ type: 'List', value, position });
const map = (value: Record<string, AttributeValue>): AttributeValue => ({ type: 'Map', value, position });
const template = (...value: TemplatePart[]): AttributeValue => ({ type: 'Template', value, position });
const reference = (...value: (string | number)[]) => ({ type: 'Reference' as const, value, position });

const inInstance = (module: ModuleAddress) => new Address(module, 'resource', 'main');
const context = Address.root('resource', 'main');

const state: State = {
  version: STATE_VERSION,
  serial: 0,
  resources: { 'resource.test': { resourceType: 'resource', name: 'test', attributes: { id: 'res-123', val: 'resolved' } } },
};

const resolverWith = (scopes = new ScopeManager(), planned = new Planned(), dataSources = new Map<string, Record<string, Value>>()) =>
  new ReferenceResolver(scopes, dataSources, new Map(), new Instances(), new ModuleInstances(), planned);

/** A template around a resource state does not hold, which only the apply makes. */
const readLater = () => resolverWith().resolveValue(template('id: ', reference('resource', 'later', 'id')), state, context);

describe('ReferenceResolver', () => {
  it.each([
    ['a string', str('simple'), valueOf(types.string, 'simple')],
    ['a number', num('42'), valueOf(types.number, ExactNumber.parse('42'))],
    ['a boolean', { type: 'Boolean', value: true, position } as AttributeValue, valueOf(types.bool, true)],
    ['null, of no type yet', { type: 'Null', position } as AttributeValue, valueOf(types.dynamic, null)],
  ])('reads %s with its type', (_, node, value) => {
    expect(resolverWith().resolveValue(node, state, context)).toEqual(value);
  });

  // Its items may be of different types, which a list's are not.
  it('reads a list as a tuple, each item with its own type', () => {
    expect(resolverWith().resolveValue(list(str('a'), num('1')), state, context)).toEqual(valueOf(types.tuple([types.string, types.number]), ['a', ExactNumber.parse('1')]));
  });

  it('reads a map as an object, each value with its own type', () => {
    expect(resolverWith().resolveValue(map({ a: str('x'), b: list() }), state, context)).toEqual(valueOf(types.object({ a: types.string, b: types.tuple([]) }), { a: 'x', b: [] }));
  });

  it('reads a reference to a resource', () => {
    expect(resolverWith().resolveValue(ref('resource', 'test', 'val'), state, context).data).toBe('resolved');
  });

  it('joins a template into text', () => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'my_var', { value: str('var_value'), context: ModuleAddress.root });

    expect(resolverWith(scopes).resolveValue(template('Var: ', reference('var', 'my_var'), ', Res: ', reference('resource', 'test', 'val')), state, context)).toEqual(
      valueOf(types.string, 'Var: var_value, Res: resolved')
    );
  });

  it('gives a template of one reference as the value itself, type and all', () => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'n', { value: num('8'), context: ModuleAddress.root });

    expect(resolverWith(scopes).resolveValue(template(reference('var', 'n')), state, context)).toEqual(valueOf(types.number, ExactNumber.parse('8')));
  });

  // The parser has already read every interpolation out of a string, so what is left is text, whatever it spells.
  it('leaves a string that spells an interpolation as text', () => {
    expect(resolverWith().resolveValue(str('Value is ${resource.test.val}'), state, context).data).toBe('Value is ${resource.test.val}');
  });

  it.each([
    ['a tuple', list(str('a')), 'var.x is a tuple and cannot be joined into a string'],
    ['an object', map({ a: str('x') }), 'var.x is an object and cannot be joined into a string'],
    ['null', { type: 'Null', position } as AttributeValue, 'var.x is null and cannot be joined into a string'],
  ])('refuses to join %s into text', (_, value, message) => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'x', { value, context: ModuleAddress.root });

    expect(() => resolverWith(scopes).resolveValue(template('a ', reference('var', 'x')), state, context)).toThrow(new ConfigError(message, position));
  });

  // A state holds what a provider made even when its schema does not, so the reference that reads it names the resource.
  it('refuses a value in state that its schema does not hold, naming the resource', () => {
    const schemas = new Map([['resource', { val: { type: types.number } }]]);
    const resolver = new ReferenceResolver(new ScopeManager(), new Map(), schemas, new Instances(), new ModuleInstances(), new Planned());

    expect(() => resolver.resolveValue(reference('resource', 'test', 'val'), state, context)).toThrow(
      new ConfigError('resource.test holds what its schema does not: val is a string, where its type is a number', position)
    );
  });

  // Its for_each is read before anything in an instance is, so a key with no value is a fault in the engine, not in the configuration.
  it('refuses each.value in an instance its for_each gave no value', () => {
    const instance = new Address(ModuleAddress.root, 'resource', 'main', 'k');

    expect(() => resolverWith().resolveValue(reference('each', 'value'), state, instance)).toThrow('each.value of "k" was read before its for_each');
  });

  // A provider may read null where its schema names a string, which has a kind that joins and no text.
  it('refuses to join a null of a type that joins into text', () => {
    const sources = new Map([['src.s', { v: valueOf(types.string, null) }]]);
    const read = () => resolverWith(new ScopeManager(), new Planned(), sources).resolveValue(template('a ', reference('data', 'src', 's', 'v')), state, context);

    expect(read).toThrow(new ConfigError('data.src.s.v is null and cannot be joined into a string', position));
  });

  // Text around it makes it a string, whatever the reference comes to.
  it('leaves a template that reads a value not known yet to the apply, as a string', () => {
    expect(readLater).toThrow(UnresolvedReferenceError);
    expect(readLater).toThrow(expect.objectContaining({ type: types.string }));
  });

  // While planning, an item only the apply can read stands on its own, with the type it will have.
  it('reads an item not known yet in a list as unknown, of the type it will have', () => {
    const planned = new Planned();
    planned.begin();

    expect(resolverWith(new ScopeManager(), planned).resolveValue(list(str('a'), template('x', reference('resource', 'later', 'id'))), state, context)).toEqual(
      valueOf(types.tuple([types.string, types.string]), ['a', UNKNOWN])
    );
  });

  // Every instance of a module reads the values declared once for it, and the resources and outputs of its own instance.
  describe('in an instance of a module', () => {
    it('reads the instance of a resource in that instance of the module', () => {
      const instances = new Instances();
      instances.declare('module.app.resource.dep', 'count');
      const held: State = {
        version: STATE_VERSION,
        serial: 0,
        resources: { 'module.app[0].resource.dep[1]': { resourceType: 'resource', name: 'dep', attributes: { id: 'one' } } },
      };

      const read = new ReferenceResolver(new ScopeManager(), new Map(), new Map(), instances, new ModuleInstances(), new Planned()).resolveValue(
        reference('resource', 'dep', 1, 'id'),
        held,
        inInstance(ModuleAddress.root.child('app', 0))
      );

      expect(read.data).toBe('one');
    });

    it('reads an input in the instance of the calling module it sits in', () => {
      const scopes = new ScopeManager();
      scopes.setVariable('module.a.module.b', 'x', { value: reference('module', 'c', 'out'), context: ModuleAddress.root.child('a') });
      scopes.setOutput('module.a[1].module.c', 'out', valueOf(types.string, 'from a[1]'));
      scopes.setOutput('module.a.module.c', 'out', valueOf(types.string, 'from a'));

      const read = resolverWith(scopes).resolveValue(reference('var', 'x'), state, inInstance(ModuleAddress.root.child('a', 1).child('b', 0)));

      expect(read.data).toBe('from a[1]');
    });

    it('reads a data source once for the module as the configuration writes it', () => {
      const sources = new Map([['module.app.src.s', { v: valueOf(types.string, 'read') }]]);

      const read = resolverWith(new ScopeManager(), new Planned(), sources).resolveValue(reference('data', 'src', 's', 'v'), state, inInstance(ModuleAddress.root.child('app', 0)));

      expect(read.data).toBe('read');
    });
  });
});
