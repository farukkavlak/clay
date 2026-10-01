import { Address, isUnknown, ModuleAddress, State, STATE_VERSION, UNKNOWN } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { DesiredResource, hasChanges, outputChanges, plan, PLAN_FILE_VERSION, PlanAction, serializePlan, validatePlanFile } from '../src/index';

/** A plan is built from parsed blocks, and a test that builds one by hand still has to say where they came from. */
const position = { file: CONFIG_FILE, line: 1, column: 1 };
const str = (value: string): AttributeValue => ({ type: 'String', value, position });

function desiredResource(name: string, attributes: Record<string, string>, modulePath: string[] = []): DesiredResource {
  return {
    address: new Address(
      modulePath.reduce((module, name) => module.child(name), ModuleAddress.root),
      'mock_resource',
      name
    ),
    block: {
      type: 'Resource',
      resourceType: 'mock_resource',
      name,
      attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, str(value)])),
      position,
    },
    attributes,
    after: attributes,
    replace: false,
    dependencies: [],
  };
}

function stateWith(name: string, attributes: Record<string, unknown>): State {
  return {
    version: STATE_VERSION,
    serial: 0,
    resources: {
      [`mock_resource.${name}`]: {
        resourceType: 'mock_resource',
        name,
        attributes,
      },
    },
  };
}

describe('Planner', () => {
  it('should plan CREATE for new resources', () => {
    const actions = plan([desiredResource('test_resource_a', { path: 'x' })], { version: STATE_VERSION, serial: 0, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].resourceType).toBe('mock_resource');
    expect(actions[0].name).toBe('test_resource_a');
    expect(actions[0].attributes!.path).toEqual(str('x'));
  });

  // The whole of what was planned, the values that change and the ones that do not, so the apply can hold each to it.
  it('carries every value it planned on a create, an update and a replace, and none on the others', () => {
    const planned = { path: 'x', size: 'large' };
    const after = { ...planned, made: UNKNOWN };
    const desired = { ...desiredResource('r', planned), after };

    expect(plan([desired], { version: STATE_VERSION, serial: 0, resources: {} })[0]).toMatchObject({ type: 'CREATE', planned, after });
    expect(plan([desired], stateWith('r', { path: 'x', size: 'small' }))[0]).toMatchObject({ type: 'UPDATE', planned, after });
    expect(plan([{ ...desired, replace: true }], stateWith('r', { path: 'old', size: 'large' }))[0]).toMatchObject({ type: 'REPLACE', planned, after });
    expect(plan([{ ...desiredResource('r', planned) }], stateWith('r', planned))[0]).not.toHaveProperty('after');
    expect(plan([], stateWith('r', planned))[0]).not.toHaveProperty('after');
  });

  // The configuration sets the same path; what changes is what the provider will make again.
  it('plans the change from what the provider plans, not from the configuration alone', () => {
    const desired = { ...desiredResource('r', { path: 'x' }), after: { path: 'x', made: UNKNOWN } };
    const [action] = plan([desired], stateWith('r', { path: 'x', made: 'before' }));

    expect(action).toMatchObject({ type: 'UPDATE', changes: { made: { old: 'before', new: UNKNOWN } } });
  });

  it('should plan CREATE for nested module resources', () => {
    const actions = plan([desiredResource('nested_resource', { size: 'large' }, ['app', 'db'])], { version: STATE_VERSION, serial: 0, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].modulePath).toEqual([{ name: 'app' }, { name: 'db' }]);
  });

  it('should carry the dependencies of a resource on every action but a delete', () => {
    const desired = { ...desiredResource('r', { path: 'x' }), dependencies: ['mock_resource.dep'] };

    expect(plan([desired], { version: STATE_VERSION, serial: 0, resources: {} })[0]).toMatchObject({ type: 'CREATE', dependencies: ['mock_resource.dep'] });
    expect(plan([desired], stateWith('r', { path: 'old' }))[0]).toMatchObject({ type: 'UPDATE', dependencies: ['mock_resource.dep'] });
    expect(plan([desired], stateWith('r', { path: 'x' }))[0]).toMatchObject({ type: 'NO_OP', dependencies: ['mock_resource.dep'] });
    expect(plan([{ ...desired, replace: true }], stateWith('r', { path: 'old' }))[0]).toMatchObject({ type: 'REPLACE', dependencies: ['mock_resource.dep'] });
    expect(plan([], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('dependencies');
  });

  it('should plan DELETE for removed resources', () => {
    const actions = plan([], stateWith('test_resource_b', {}));

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'DELETE', resourceType: 'mock_resource', name: 'test_resource_b', modulePath: [] });
  });

  it('should plan UPDATE when attributes change', () => {
    const actions = plan([desiredResource('test_resource_c', { path: 'new_path' })], stateWith('test_resource_c', { path: 'old_path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('UPDATE');
    expect(actions[0].changes!.path).toEqual({ old: 'old_path', new: 'new_path' });
  });

  it('should keep the config attributes on an UPDATE so the apply can resolve them again', () => {
    const actions = plan([desiredResource('test_resource_c', { path: 'new_path' })], stateWith('test_resource_c', { path: 'old_path' }));

    expect(actions[0].attributes).toEqual({ path: str('new_path') });
  });

  it('should plan NO_OP when the resolved values match the state', () => {
    const actions = plan([desiredResource('test_resource_d', { path: 'path' })], stateWith('test_resource_d', { path: 'path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('NO_OP');
    expect(actions[0].changes).toBeUndefined();
  });

  it('should plan NO_OP when a map holds the same values in another order', () => {
    const desired = desiredResource('test_resource_g', { path: 'path' });

    const attributes = { triggers: { b: '2', a: '1' } };
    const actions = plan([{ ...desired, attributes, after: attributes }], stateWith('test_resource_g', { triggers: { a: '1', b: '2' } }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('NO_OP');
    expect(actions[0].changes).toBeUndefined();
  });

  // A name every object answers to used to come back as its inherited function instead of undefined, so an addition read as a change from that function.
  it('should report an output named after something every object has as an addition', () => {
    expect(outputChanges({}, { constructor: 'hello' })).toEqual({ constructor: { old: undefined, new: 'hello' } });
  });

  it('should report an output named that way as a removal when it goes away', () => {
    expect(outputChanges({ toString: 'bye' }, {})).toEqual({ toString: { old: 'bye', new: undefined } });
  });

  // A state file can hold `__proto__` as a name of its own, and assigning it into a plain object sets a prototype rather than a key.
  it('should see a change to an attribute named __proto__, which a state file can carry', () => {
    expect(hasChanges(JSON.parse('{"__proto__":"old"}'), { __proto__: 'new' })).toBe(true);
  });

  it('should treat an unknown value as a change', () => {
    const desired = desiredResource('test_resource_e', { path: 'path' });
    const actions = plan([{ ...desired, attributes: { path: UNKNOWN }, after: { path: UNKNOWN } }], stateWith('test_resource_e', { path: 'path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('UPDATE');
    expect(actions[0].changes!.path).toEqual({ old: 'path', new: UNKNOWN });
  });

  // Only the engine can make the marker; a value the configuration spells, whatever its keys, is a value.
  it('plans no change for a map that only looks like the unknown marker', () => {
    const lookalike = { '@@clay/unknown': true };

    expect(isUnknown(lookalike)).toBe(false);
    expect(hasChanges({ triggers: lookalike }, { triggers: { ...lookalike } })).toBe(false);
  });

  it('should plan one REPLACE when the provider plans to replace the resource', () => {
    const actions = plan([{ ...desiredResource('test_resource_f', { path: 'new_path' }), replace: true }], stateWith('test_resource_f', { path: 'old_path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('REPLACE');
    expect(actions[0].attributes).toEqual({ path: str('new_path') });
    expect(actions[0].changes).toEqual({ path: { old: 'old_path', new: 'new_path' } });
  });

  // The provider decides; a resource it plans to replace is replaced even when it would come out holding the same values.
  it('plans a REPLACE the provider asks for with no value changing', () => {
    const [action] = plan([{ ...desiredResource('r', { path: 'x' }), replace: true }], stateWith('r', { path: 'x' }));

    expect(action).toMatchObject({ type: 'REPLACE', changes: {} });
  });

  it('should tell a replaced resource in a module apart from a removed one', () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: {
        'module.app.mock_resource.same': { resourceType: 'mock_resource', name: 'same', modulePath: [{ name: 'app' }], attributes: { path: 'old' } },
        'mock_resource.same': { resourceType: 'mock_resource', name: 'same', attributes: { path: 'old' } },
      },
    };

    const actions = plan([{ ...desiredResource('same', { path: 'new' }, ['app']), replace: true }], state);

    expect(actions.map((action) => [action.type, Address.of(action).toString()])).toEqual([
      ['REPLACE', 'module.app.mock_resource.same'],
      ['DELETE', 'mock_resource.same'],
    ]);
  });

  describe('Plan Serialization', () => {
    it('should serialize plan correctly', () => {
      const actions: PlanAction[] = [];
      const config = 'resource "test" {}';
      const serialized = JSON.parse(serializePlan({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {} }, config, { 'm/main.clay': 'output "x" { value = "y" }' }));

      expect(serialized.version).toBe(PLAN_FILE_VERSION);
      expect(serialized.actions).toEqual(actions);
      expect(serialized.config).toBe(config);
      expect(serialized.modules).toEqual({ 'm/main.clay': 'output "x" { value = "y" }' });
      expect(serialized.timestamp).toBeDefined();
    });

    it('should validate correct plan file', () => {
      const planFile = {
        version: PLAN_FILE_VERSION,
        timestamp: new Date().toISOString(),
        config: 'resource "test" {}',
        modules: {},
        serial: 0,
        actions: [],
        outputs: {},
        prevRun: {},
        prior: {},
      };

      expect(validatePlanFile(planFile)).toBe(true);
    });

    it('should reject a plan file without the state serial it was made from', () => {
      const planFile = { version: PLAN_FILE_VERSION, timestamp: new Date().toISOString(), config: '', modules: {}, actions: [] };

      expect(validatePlanFile(planFile)).toBe(false);
    });

    it('should reject invalid plan file', () => {
      expect(validatePlanFile(null)).toBe(false);
      expect(validatePlanFile({})).toBe(false);
      expect(validatePlanFile({ version: 1 })).toBe(false); // wrong type
    });

    it('should reject a plan file from an older version', () => {
      const v1 = { version: '1.0', timestamp: new Date().toISOString(), configHash: 'hash', actions: [] };
      const v2 = { version: '2.0', timestamp: new Date().toISOString(), config: '', actions: [] };
      const v3 = { version: '3.0', timestamp: new Date().toISOString(), config: '', modules: {}, actions: [] };

      expect(validatePlanFile(v1)).toBe(false);
      expect(validatePlanFile(v2)).toBe(false);
      expect(validatePlanFile(v3)).toBe(false);
    });
  });
});
