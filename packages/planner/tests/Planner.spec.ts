import { Address, isUnknown, ModuleAddress, Output, State, STATE_VERSION, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { DesiredResource, hasChanges, outputChanges, plan, PLAN_FILE_VERSION, PlanAction, serializePlan, validatePlanFile } from '../src/index';

const position = { file: CONFIG_FILE, line: 1, column: 1 };
const str = (value: string): AttributeValue => ({ type: 'String', value, position });
const text = (value: string): Output => ({ value, type: types.string });

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
    sensitive: [],
    replace: false,
    dependencies: [],
  };
}

function first(resource: DesiredResource): DesiredResource {
  return { ...resource, createBeforeDestroy: true };
}

function ignoring(resource: DesiredResource, ignored: string[][]): DesiredResource {
  return { ...resource, ignored };
}

function withDeposed(state: State, ...addresses: string[]): State {
  return { ...state, deposed: Object.fromEntries(addresses.map((address) => [address, [{ attributes: {} }]])) };
}

function preventing(name: string, attributes: Record<string, string>): DesiredResource {
  const resource = desiredResource(name, attributes);
  return { ...resource, block: { ...resource.block, lifecycle: { preventDestroy: true, position } } };
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
  });

  // Every planned value, changed or not, so the apply can check each one.
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

  it('carries which parts are sensitive on a create, an update, a replace and a no-op, and nothing where none is', () => {
    const planned = { path: 'x', size: 'large' };
    const sensitive = [['size']];
    const desired = { ...desiredResource('r', planned), sensitive };

    expect(plan([desired], { version: STATE_VERSION, serial: 0, resources: {} })[0]).toMatchObject({ type: 'CREATE', sensitive });
    expect(plan([desired], stateWith('r', { path: 'x', size: 'small' }))[0]).toMatchObject({ type: 'UPDATE', sensitive });
    expect(plan([{ ...desired, replace: true }], stateWith('r', { path: 'old', size: 'large' }))[0]).toMatchObject({ type: 'REPLACE', sensitive });
    expect(plan([desired], stateWith('r', planned))[0]).toMatchObject({ type: 'NO_OP', sensitive });
    expect(plan([desiredResource('r', planned)], stateWith('r', planned))[0]).not.toHaveProperty('sensitive');
  });

  describe('create_before_destroy', () => {
    it('is carried by a replace only', () => {
      const empty = { version: STATE_VERSION, serial: 0, resources: {} };

      expect(plan([{ ...first(desiredResource('r', { path: 'y' })), replace: true }], stateWith('r', { path: 'x' }))[0]).toMatchObject({
        type: 'REPLACE',
        createBeforeDestroy: true,
      });
      expect(plan([first(desiredResource('r', { path: 'y' }))], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('createBeforeDestroy');
      expect(plan([first(desiredResource('r', { path: 'x' }))], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('createBeforeDestroy');
      expect(plan([first(desiredResource('r', { path: 'x' }))], empty)[0]).not.toHaveProperty('createBeforeDestroy');
      expect(plan([{ ...desiredResource('r', { path: 'y' }), replace: true }], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('createBeforeDestroy');
    });
  });

  describe('deposed objects', () => {
    it('are destroyed beside a resource that stays, as an action of their own', () => {
      const actions = plan([desiredResource('r', { path: 'x' })], withDeposed(stateWith('r', { path: 'x' }), 'mock_resource.r'));

      expect(actions.map((action) => action.type)).toEqual(['NO_OP', 'DELETE']);
      expect(actions[1]).toMatchObject({ type: 'DELETE', deposed: true, resourceType: 'mock_resource', name: 'r' });
    });

    it('are destroyed with a resource the configuration drops, and where there is none', () => {
      const dropped = plan([], withDeposed(stateWith('r', {}), 'mock_resource.r'));
      const alone = plan([], withDeposed({ version: STATE_VERSION, serial: 0, resources: {} }, 'mock_resource.gone[1]'));

      expect(dropped.map((action) => action.deposed)).toEqual([undefined, true]);
      expect(alone).toMatchObject([{ type: 'DELETE', deposed: true, name: 'gone', key: 1 }]);
    });

    it('add no action to a state with none, and mark no other delete', () => {
      const [action] = plan([], stateWith('r', {}));

      expect(action.type).toBe('DELETE');
      expect(action).not.toHaveProperty('deposed');
    });
  });

  describe('ignored paths', () => {
    it('are carried by an update and a replace, and by no other action', () => {
      const empty = { version: STATE_VERSION, serial: 0, resources: {} };
      const ignored = [['path']];

      expect(plan([ignoring(desiredResource('r', { path: 'y' }), ignored)], stateWith('r', { path: 'x' }))[0]).toMatchObject({ type: 'UPDATE', ignored });
      expect(plan([{ ...ignoring(desiredResource('r', { path: 'y' }), ignored), replace: true }], stateWith('r', { path: 'x' }))[0]).toMatchObject({ type: 'REPLACE', ignored });
      expect(plan([ignoring(desiredResource('r', { path: 'x' }), ignored)], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('ignored');
      expect(plan([ignoring(desiredResource('r', { path: 'x' }), ignored)], empty)[0]).not.toHaveProperty('ignored');
      expect(plan([], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('ignored');
    });

    it('are left out where none is ignored', () => {
      expect(plan([ignoring(desiredResource('r', { path: 'y' }), [])], stateWith('r', { path: 'x' }))[0]).not.toHaveProperty('ignored');
    });
  });

  describe('prevent_destroy', () => {
    const planned = { path: 'x' };
    const protectedState = (): State => {
      const state = stateWith('r', planned);
      state.resources['mock_resource.r'].preventDestroy = true;
      return state;
    };

    it('is carried by a create, an update, a replace and a no-op, and by none of them where the block does not say it', () => {
      const empty = { version: STATE_VERSION, serial: 0, resources: {} };

      expect(plan([preventing('r', planned)], empty)[0]).toMatchObject({ type: 'CREATE', preventDestroy: true });
      expect(plan([preventing('r', { path: 'y' })], stateWith('r', planned))[0]).toMatchObject({ type: 'UPDATE', preventDestroy: true });
      expect(plan([{ ...preventing('r', { path: 'y' }), replace: true }], stateWith('r', planned))[0]).toMatchObject({ type: 'REPLACE', preventDestroy: true });
      expect(plan([preventing('r', planned)], protectedState())[0]).toMatchObject({ type: 'NO_OP', preventDestroy: true });
      expect(plan([desiredResource('r', planned)], empty)[0]).not.toHaveProperty('preventDestroy');
      expect(plan([desiredResource('r', planned)], protectedState())[0]).not.toHaveProperty('preventDestroy');
    });

    it('is not carried by a delete, which the state is judged by', () => {
      const [action] = plan([], protectedState());

      expect(action.type).toBe('DELETE');
      expect(action).not.toHaveProperty('preventDestroy');
    });

    it('says a no-op changes it where the block and the state disagree, and only then', () => {
      expect(plan([preventing('r', planned)], stateWith('r', planned))[0]).toMatchObject({ type: 'NO_OP', protectionChange: true });
      expect(plan([desiredResource('r', planned)], protectedState())[0]).toMatchObject({ type: 'NO_OP', protectionChange: true });
      expect(plan([preventing('r', planned)], protectedState())[0]).not.toHaveProperty('protectionChange');
      expect(plan([desiredResource('r', planned)], stateWith('r', planned))[0]).not.toHaveProperty('protectionChange');
    });
  });

  it('says a no-op changes which parts are sensitive where the state marks other parts, and only then', () => {
    const planned = { path: 'x', size: 'large' };
    const markedIn = (sensitive: string[][]) => {
      const state = stateWith('r', planned);
      state.resources['mock_resource.r'].sensitive = sensitive;
      return state;
    };
    const desired = { ...desiredResource('r', planned), sensitive: [['size']] };

    expect(plan([desired], stateWith('r', planned))[0]).toMatchObject({ type: 'NO_OP', marksChange: true });
    expect(plan([desiredResource('r', planned)], markedIn([['size']]))[0]).toMatchObject({ type: 'NO_OP', marksChange: true });
    expect(plan([desired], markedIn([['path']]))[0]).toMatchObject({ type: 'NO_OP', marksChange: true });
    expect(plan([desired], markedIn([['size']]))[0]).not.toHaveProperty('marksChange');
    expect(plan([{ ...desired, sensitive: [['size'], ['path']] }], markedIn([['path'], ['size']]))[0]).not.toHaveProperty('marksChange');
    expect(plan([desiredResource('r', planned)], stateWith('r', planned))[0]).not.toHaveProperty('marksChange');
    expect(plan([desired], stateWith('r', { path: 'x', size: 'small' }))[0]).not.toHaveProperty('marksChange');
  });

  // The configuration is unchanged; the change comes from the provider's plan.
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

  // An inherited name like `constructor` used to read as a change from the inherited function.
  it('should report an output named after something every object has as an addition', () => {
    expect(outputChanges({}, { constructor: text('hello') })).toEqual({ constructor: { old: undefined, new: text('hello') } });
  });

  it('should report an output whose type alone changes, since the same members as a set and as a list are two values', () => {
    const list = { value: ['a'], type: types.list(types.string) };
    const set = { value: ['a'], type: types.set(types.string) };

    expect(outputChanges({ o: list }, { o: set })).toEqual({ o: { old: list, new: set } });
  });

  it('should report an output named that way as a removal when it goes away', () => {
    expect(outputChanges({ toString: text('bye') }, {})).toEqual({ toString: { old: text('bye'), new: undefined } });
  });

  // A state file can hold `__proto__` as a key, which a plain object would treat as its prototype.
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

  // UNKNOWN is a symbol, so a map spelled like a marker is an ordinary value.
  it('plans no change for a map that only looks like the unknown marker', () => {
    const lookalike = { '@@clay/unknown': true };

    expect(isUnknown(lookalike)).toBe(false);
    expect(hasChanges({ triggers: lookalike }, { triggers: { ...lookalike } })).toBe(false);
  });

  it('should plan one REPLACE when the provider plans to replace the resource', () => {
    const actions = plan([{ ...desiredResource('test_resource_f', { path: 'new_path' }), replace: true }], stateWith('test_resource_f', { path: 'old_path' }));

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('REPLACE');
    expect(actions[0].changes).toEqual({ path: { old: 'old_path', new: 'new_path' } });
  });

  // The provider decides: a replace happens even when no value changes.
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
      const serialized = JSON.parse(
        serializePlan({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: {}, dataSources: {}, readAtApply: [] }, config, {
          'm/main.clay': 'output "x" { value = "y" }',
        })
      );

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
        schemas: {},
        dataSources: {},
        readAtApply: [],
      };

      expect(validatePlanFile(planFile)).toBe(true);
    });

    it.each([
      [
        'steps',
        [
          ['tags', 'token'],
          ['list', 1],
        ],
        true,
      ],
      ['a string', 'content', false],
      ['a step that is neither a name nor an index', [['content', 1.5]], false],
      ['a step that is an object', [[{ name: 'content' }]], false],
    ])('takes the sensitive parts of an action as %s', (_, sensitive, valid) => {
      const action = { type: 'NO_OP', resourceType: 'thing', name: 'a', sensitive };
      const planFile = {
        version: PLAN_FILE_VERSION,
        timestamp: new Date().toISOString(),
        config: '',
        modules: {},
        serial: 0,
        actions: [action],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: {},
        dataSources: {},
        readAtApply: [],
      };

      expect(validatePlanFile(planFile)).toBe(valid);
    });

    it('should reject a plan file without the state serial it was made from', () => {
      const planFile = { version: PLAN_FILE_VERSION, timestamp: new Date().toISOString(), config: '', modules: {}, actions: [] };

      expect(validatePlanFile(planFile)).toBe(false);
    });

    it('should reject invalid plan file', () => {
      expect(validatePlanFile(null)).toBe(false);
      expect(validatePlanFile({})).toBe(false);
      expect(validatePlanFile({ version: 1 })).toBe(false);
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
