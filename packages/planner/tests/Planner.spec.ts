import { IState } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { DesiredResource, plan, PLAN_FILE_VERSION, PlanAction, serializePlan, UNKNOWN, validatePlanFile } from '../src/index';

/** A plan is built from parsed blocks, and a test that builds one by hand still has to say where they came from. */
const position = { file: CONFIG_FILE, line: 1, column: 1 };
const str = (value: string): AttributeValue => ({ type: 'String', value, position });

function desiredResource(name: string, attributes: Record<string, string>, modulePath?: string[]): DesiredResource {
  return {
    block: {
      type: 'Resource',
      resourceType: 'mock_resource',
      name,
      modulePath,
      attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, str(value)])),
      position,
    },
    attributes,
    dependencies: [],
  };
}

function stateWith(name: string, attributes: Record<string, unknown>, id = `mock_resource.${name}`): IState {
  return {
    version: 1,
    serial: 0,
    resources: {
      [`mock_resource.${name}`]: {
        id,
        type: 'Resource',
        resourceType: 'mock_resource',
        name,
        attributes,
      },
    },
  };
}

describe('Planner', () => {
  it('should plan CREATE for new resources', () => {
    const actions = plan([desiredResource('test_resource_a', { path: 'x' })], { version: 1, serial: 0, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].resourceType).toBe('mock_resource');
    expect(actions[0].name).toBe('test_resource_a');
    expect(actions[0].attributes!.path).toEqual(str('x'));
  });

  it('should plan CREATE for nested module resources', () => {
    const actions = plan([desiredResource('nested_resource', { size: 'large' }, ['app', 'db'])], { version: 1, serial: 0, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].modulePath).toEqual(['app', 'db']);
  });

  it('should carry the dependencies of a resource on every action but a delete', () => {
    const desired = { ...desiredResource('r', { path: 'x' }), dependencies: ['mock_resource.dep'] };

    expect(plan([desired], { version: 1, serial: 0, resources: {} })[0]).toMatchObject({ type: 'CREATE', dependencies: ['mock_resource.dep'] });
    expect(plan([desired], stateWith('r', { path: 'old' }))[0]).toMatchObject({ type: 'UPDATE', dependencies: ['mock_resource.dep'] });
    expect(plan([desired], stateWith('r', { path: 'x' }))[0]).toMatchObject({ type: 'NO_OP', dependencies: ['mock_resource.dep'] });
    const forcesNew = Object.fromEntries([[desired.block.resourceType, { path: { type: 'string' as const, forceNew: true } }]]);
    expect(plan([desired], stateWith('r', { path: 'old' }), forcesNew)[0]).toMatchObject({ type: 'REPLACE', dependencies: ['mock_resource.dep'] });
    expect(plan([], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('dependencies');
  });

  it('should plan DELETE for removed resources', () => {
    const actions = plan([], stateWith('test_resource_b', {}));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('DELETE');
    expect(actions[0].id).toBe('mock_resource.test_resource_b');
  });

  it('should plan UPDATE when attributes change', () => {
    const actions = plan([desiredResource('test_resource_c', { path: 'new_path' })], stateWith('test_resource_c', { path: 'old_path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('UPDATE');
    expect(actions[0].id).toBe('mock_resource.test_resource_c');
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

  it('should treat an unknown value as a change', () => {
    const desired = desiredResource('test_resource_e', { path: 'path' });
    const actions = plan([{ ...desired, attributes: { path: UNKNOWN } }], stateWith('test_resource_e', { path: 'path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('UPDATE');
    expect(actions[0].changes!.path).toEqual({ old: 'path', new: UNKNOWN });
  });

  const schemas = {
    mock_resource: {
      path: { type: 'string' as const, required: true, forceNew: true },
    },
  };

  it('should plan one REPLACE when a forceNew attribute changes', () => {
    const actions = plan([desiredResource('test_resource_f', { path: 'new_path' })], stateWith('test_resource_f', { path: 'old_path' }, 'mock_id_123'), schemas);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('REPLACE');
    expect(actions[0].id).toBe('mock_id_123');
    expect(actions[0].attributes).toEqual({ path: str('new_path') });
    expect(actions[0].changes).toEqual({ path: { old: 'old_path', new: 'new_path' } });
  });

  it('should tell a replaced resource in a module apart from a removed one', () => {
    const state: IState = {
      version: 1,
      serial: 0,
      resources: {
        'module.app.mock_resource.same': { id: 'in_module', type: 'Resource', resourceType: 'mock_resource', name: 'same', modulePath: ['app'], attributes: { path: 'old' } },
        'mock_resource.same': { id: 'at_root', type: 'Resource', resourceType: 'mock_resource', name: 'same', attributes: { path: 'old' } },
      },
    };

    const actions = plan([desiredResource('same', { path: 'new' }, ['app'])], state, schemas);

    expect(actions.map((action) => [action.type, action.id])).toEqual([
      ['REPLACE', 'in_module'],
      ['DELETE', 'at_root'],
    ]);
  });

  describe('Plan Serialization', () => {
    it('should serialize plan correctly', () => {
      const actions: PlanAction[] = [];
      const config = 'resource "test" {}';
      const serialized = serializePlan({ serial: 0, actions, outputs: {} }, config, { 'm/main.clay': 'output "x" { value = "y" }' });

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
