import { IState } from '@miniform/state';
import { describe, expect, it } from 'vitest';

import { DesiredResource, plan, PlanAction, serializePlan, UNKNOWN, validatePlanFile } from '../src/index';

function desiredResource(name: string, attributes: Record<string, string>, modulePath?: string[]): DesiredResource {
  return {
    block: {
      type: 'Resource',
      resourceType: 'mock_resource',
      name,
      modulePath,
      attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { type: 'String' as const, value }])),
    },
    attributes,
  };
}

function stateWith(name: string, attributes: Record<string, unknown>, id = `mock_resource.${name}`): IState {
  return {
    version: 1,
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
    const actions = plan([desiredResource('test_resource_a', { path: 'x' })], { version: 1, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].resourceType).toBe('mock_resource');
    expect(actions[0].name).toBe('test_resource_a');
    expect(actions[0].attributes!.path).toEqual({ type: 'String', value: 'x' });
  });

  it('should plan CREATE for nested module resources', () => {
    const actions = plan([desiredResource('nested_resource', { size: 'large' }, ['app', 'db'])], { version: 1, resources: {} });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('CREATE');
    expect(actions[0].modulePath).toEqual(['app', 'db']);
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

    expect(actions[0].attributes).toEqual({ path: { type: 'String', value: 'new_path' } });
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

  it('should plan DELETE + CREATE when forceNew attribute changes', () => {
    const schemas = {
      mock_resource: {
        path: { type: 'string' as const, required: true, forceNew: true },
      },
    };

    const actions = plan([desiredResource('test_resource_f', { path: 'new_path' })], stateWith('test_resource_f', { path: 'old_path' }, 'mock_id_123'), schemas);

    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('DELETE');
    expect(actions[0].id).toBe('mock_id_123');
    expect(actions[1].type).toBe('CREATE');
    expect(actions[1].attributes).toEqual({ path: { type: 'String', value: 'new_path' } });
  });

  describe('Plan Serialization', () => {
    it('should serialize plan correctly', () => {
      const actions: PlanAction[] = [];
      const config = 'resource "test" {}';
      const serialized = serializePlan(actions, config);

      expect(serialized.version).toBe('1.0');
      expect(serialized.actions).toEqual(actions);
      expect(serialized.configHash).toBeDefined();
      expect(serialized.timestamp).toBeDefined();
    });

    it('should validate correct plan file', () => {
      const planFile = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        configHash: 'hash',
        actions: [],
      };

      expect(validatePlanFile(planFile)).toBe(true);
    });

    it('should reject invalid plan file', () => {
      expect(validatePlanFile(null)).toBe(false);
      expect(validatePlanFile({})).toBe(false);
      expect(validatePlanFile({ version: 1 })).toBe(false); // wrong type
    });
  });
});
