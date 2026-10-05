import { ExactNumber, isUnknown, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { parsePlanFile, Plan, serializePlan } from '../src/index';

// Empty schemas: these tests are about the file, not the schemas.
const schemas = { null_resource: {}, x: {} };

const emptyPlan: Plan = { serial: 0, actions: [], outputs: {}, prevRun: {}, prior: {}, schemas };

const aPlanFile = (plan: Plan = emptyPlan) => serializePlan(plan, 'resource "a" "b" {}', { 'm/main.clay': '' });

const fields = () => JSON.parse(aPlanFile()) as Record<string, unknown>;

const read = (content: unknown) => () => parsePlanFile(typeof content === 'string' ? content : JSON.stringify(content), 'tfplan.json');

describe('reading a plan file', () => {
  // Built once: `serializePlan` stamps the time, so two calls can differ.
  it('reads back what it wrote', () => {
    const written = aPlanFile();

    expect(parsePlanFile(written, 'tfplan.json')).toEqual(JSON.parse(written));
  });

  // UNKNOWN has no JSON form, so it must come back as UNKNOWN, not as its placeholder.
  it('reads a value that is not known yet back as one, in an action and in an output', () => {
    const plan: Plan = {
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        {
          type: 'UPDATE',
          resourceType: 'null_resource',
          name: 'a',
          planned: { triggers: UNKNOWN },
          after: { triggers: UNKNOWN },
          changes: { triggers: { old: 'x', new: UNKNOWN } },
        },
      ],
      outputs: { id: { old: undefined, new: { value: UNKNOWN, type: types.string } } },
    };

    const read = parsePlanFile(aPlanFile(plan), 'tfplan.json');

    expect(isUnknown(read.actions[0].changes!.triggers.new)).toBe(true);
    expect(read.actions[0].changes!.triggers.old).toBe('x');
    expect(read.outputs.id.new).toEqual({ value: UNKNOWN, type: types.string });
  });

  it('reads a map that only looks like the unknown marker back as that map', () => {
    const lookalike = { '@@clay/unknown': true };
    const plan: Plan = {
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        {
          type: 'UPDATE',
          resourceType: 'null_resource',
          name: 'a',
          planned: { triggers: lookalike },
          after: { triggers: lookalike },
          changes: { triggers: { old: {}, new: lookalike } },
        },
      ],
      outputs: {},
    };

    const change = parsePlanFile(aPlanFile(plan), 'tfplan.json').actions[0].changes!.triggers;

    expect(isUnknown(change.new)).toBe(false);
    expect(change.new).toEqual(lookalike);
  });

  // Values in saved attributes stay exact; positions and indexes become plain numbers.
  it('reads the positions and indexes in saved attributes as numbers, and the values in them exactly, however deep', () => {
    const at = { file: 'main.clay', line: 3, column: 7 };
    const plan: Plan = {
      serial: 4,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        {
          type: 'CREATE',
          resourceType: 'null_resource',
          name: 'a',
          attributes: {
            id: { type: 'Number', value: ExactNumber.parse('12345678901234567890'), position: at },
            tags: { type: 'List', value: [{ type: 'Map', value: { n: { type: 'Number', value: ExactNumber.parse('1'), position: at } }, position: at }], position: at },
            label: { type: 'Template', value: ['id ', { type: 'Reference', value: ['var', 'ids', 0], position: at }], position: at },
            first: { type: 'Reference', value: ['var', 'ids', 1, 'name'], position: at },
            size: { type: 'Call', name: 'length', args: [{ type: 'Reference', value: ['var', 'ids', 2], position: at }], path: [0, 'a'], position: at },
            names: {
              type: 'For',
              valueName: 'n',
              collection: { type: 'Reference', value: ['var', 'ids', 3], position: at },
              body: { type: 'Bound', value: ['n', 4], position: at },
              position: at,
            },
            byName: {
              type: 'For',
              valueName: 'n',
              collection: { type: 'Reference', value: ['var', 'ids', 5], position: at },
              key: { type: 'Bound', value: ['n', 6], position: at },
              body: { type: 'Bound', value: ['n'], position: at },
              grouped: true,
              position: at,
            },
          },
          planned: {},
          after: {},
        },
      ],
      outputs: {},
    };

    const read = parsePlanFile(aPlanFile(plan), 'tfplan.json');

    expect(read.serial).toBe(4);
    expect(read.actions[0].attributes).toEqual(plan.actions[0].attributes);
  });

  // The known parts stay exact, and the unknown parts come back where they were.
  it('reads a value known in part back as it was written', () => {
    const tags = { env: UNKNOWN, list: ['a', UNKNOWN], size: ExactNumber.parse('12345678901234567890'), unknown: [['env']] };
    const plan: Plan = { serial: 0, actions: [], outputs: { tags: { old: undefined, new: { value: tags, type: types.dynamic } } }, prevRun: {}, prior: {}, schemas };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').outputs.tags.new?.value).toEqual(tags);
  });

  it.each([
    ['steps that are no list', 'env'],
    ['a step that is neither a key nor an index', [[true]]],
    ['steps to a key the value does not have', [['missing']]],
    ['steps past the end of a list', [['list', 2]]],
    ['a key into a list', [['list', 'a']]],
    ['an index below 0', [['list', -1]]],
    ['a path through the whole value', [[], ['env']]],
    ['a path through another', [['list'], ['list', 1]]],
    ['the same path twice', [['env'], ['env']]],
  ])('refuses a change that says a value is unknown with %s', (_, unknown) => {
    const changes = { tags: { new: { env: null, list: ['a', null] }, unknown } };
    const content = { ...fields(), actions: [{ type: 'UPDATE', resourceType: 'x', name: 'a', planned: {}, after: {}, changes }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['a bare value', { old: 'a' }],
    ['a value with no type', { new: { value: 'a' } }],
    ['a type with no value', { new: { type: { kind: 'string' } } }],
    ['a type that is none', { new: { value: 'a', type: { kind: 'text' } } }],
    ['a type said to be not known yet', { new: { value: 'a', type: { kind: 'string' } }, unknown: [['type']] }],
    ['a side said to be not known yet, type and all', { new: { value: 'a', type: { kind: 'string' } }, unknown: [[]] }],
    ['a value said to be not known yet where it holds nothing', { new: { value: { env: null }, type: { kind: 'dynamic' } }, unknown: [['value', 'nope']] }],
    ['a value said to be not known yet twice', { new: { value: { env: null }, type: { kind: 'dynamic' } }, unknown: [['value'], ['value', 'env']] }],
    ['steps to what is not known yet that are no list', { new: { value: { env: null }, type: { kind: 'dynamic' } }, unknown: 'value' }],
  ])('refuses an output change that holds %s', (_, change) => {
    expect(read({ ...fields(), outputs: { o: change } })).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('keeps a change whose name every object has, rather than setting a prototype', () => {
    const plan: Plan = {
      serial: 0,
      actions: [],
      outputs: JSON.parse('{"__proto__": {"old": {"value": "a", "type": {"kind": "string"}}, "new": {"value": "b", "type": {"kind": "string"}}}}'),
      prevRun: {},
      prior: {},
      schemas,
    };

    const outputs = parsePlanFile(aPlanFile(plan), 'tfplan.json').outputs;

    expect(Object.keys(outputs)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(outputs)).toBe(Object.prototype);
  });

  it('names a number out of range, rather than calling the file something other than JSON', () => {
    const text = aPlanFile().replace('"outputs": {}', '"outputs": {"o": {"old": 1e5000}}');

    expect(() => parsePlanFile(text, 'tfplan.json')).toThrow(
      'tfplan.json is not a plan file: "1e5000" is out of range: a number reaches at most 1000 places either side of the point'
    );
  });

  it('reads the instance keys of actions back as they were written', () => {
    const plan: Plan = {
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        { type: 'DELETE', resourceType: 'null_resource', name: 'a', key: 0 },
        { type: 'DELETE', resourceType: 'null_resource', name: 'a', key: 'x.y' },
      ],
      outputs: {},
    };

    const [byIndex, byName] = parsePlanFile(aPlanFile(plan), 'tfplan.json').actions;

    expect(byIndex.key).toBe(0);
    expect(byName.key).toBe('x.y');
  });

  it('reads the module keys of actions back as they were written', () => {
    const modulePath = [{ name: 'm', key: 0 }, { name: 'n', key: 'x.y' }, { name: 'o' }];
    const plan: Plan = { serial: 0, actions: [{ type: 'DELETE', resourceType: 'null_resource', name: 'a', modulePath }], outputs: {}, prevRun: {}, prior: {}, schemas };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').actions[0].modulePath).toEqual(modulePath);
  });

  it('names a module key that is not whole', () => {
    const content = { ...fields(), actions: [{ type: 'DELETE', resourceType: 'null_resource', name: 'a', modulePath: [{ name: 'm', key: 1.5 }] }] };

    expect(read(content)).toThrow('tfplan.json is not a plan file: a module key: 1.5 is not a whole number');
  });

  const keyed = (key: unknown) => ({ ...fields(), actions: [{ type: 'DELETE', resourceType: 'null_resource', name: 'a', key }] });

  it.each([
    ['a negative number', -1],
    ['a bool', true],
    ['a list', [0]],
  ])('refuses an instance key that is %s', (_, key) => {
    expect(read(keyed(key))).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['a number', 5],
    ['text that is no address', 'nowhere'],
    ['another resource', 'local_file.x'],
    ['an index other than the first', 'module.m[0].null_resource.a[1]'],
    ['another instance of its module', 'module.m[1].null_resource.a'],
    ['the resource outside its module', 'null_resource.a'],
  ])('refuses a move from %s', (_, movedFrom) => {
    const content = { ...fields(), actions: [{ type: 'NO_OP', resourceType: 'null_resource', name: 'a', modulePath: [{ name: 'm', key: 0 }], key: 0, movedFrom }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['text', 'm'],
    ['a list that holds no names', [1]],
    ['a list of bare names', ['m']],
    ['a module key that is no key', [{ name: 'm', key: -1 }]],
  ])('refuses an action whose module path is %s', (_, modulePath) => {
    const content = { ...fields(), actions: [{ type: 'DELETE', resourceType: 'null_resource', name: 'a', modulePath }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('reads a move each way back as it was written', () => {
    const plan: Plan = {
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        { type: 'NO_OP', resourceType: 'null_resource', name: 'a', key: 0, movedFrom: 'null_resource.a' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'b', movedFrom: 'null_resource.b[0]' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'c', modulePath: [{ name: 'm', key: 1 }], key: 0, movedFrom: 'module.m[1].null_resource.c' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'd', modulePath: [{ name: 'm', key: 0 }], movedFrom: 'module.m.null_resource.d' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'e', modulePath: [{ name: 'm' }], movedFrom: 'module.m[0].null_resource.e[0]' },
      ],
      outputs: {},
    };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').actions.map((action) => action.movedFrom)).toEqual([
      'null_resource.a',
      'null_resource.b[0]',
      'module.m[1].null_resource.c',
      'module.m.null_resource.d',
      'module.m[0].null_resource.e[0]',
    ]);
  });

  it('names an instance key that is not whole', () => {
    expect(read(keyed(1.5))).toThrow('tfplan.json is not a plan file: an instance key: 1.5 is not a whole number');
  });

  it('reads back the resources as state held them and as the refresh read them, keys and numbers as state reads them', () => {
    const resources = { 'x.a[0]': { resourceType: 'x', name: 'a', key: 0, attributes: { n: ExactNumber.parse('12345678901234567890') } } };

    const read = parsePlanFile(aPlanFile({ ...emptyPlan, prevRun: resources, prior: {} }), 'tfplan.json');

    expect(read.prevRun).toEqual(resources);
    expect(read.prior).toEqual({});
  });

  it.each([
    ['no resources read back', { prior: undefined }, 'tfplan.json is not a plan file: its prior resources are not a record'],
    ['an entry that is not a resource', { prior: { 'x.a': { name: 'a' } } }, 'tfplan.json is not a plan file: "x.a" is not a resource'],
    [
      'an instance key that is not whole',
      { prior: { 'x.a': { resourceType: 'x', name: 'a', key: 1.5, attributes: {} } } },
      'tfplan.json is not a plan file: the key of "x.a": 1.5 is not a whole number',
    ],
    ['an entry filed under another address', { prevRun: { 'x.b': { resourceType: 'x', name: 'a', attributes: {} } } }, 'tfplan.json is not a plan file: "x.b" holds x.a'],
  ])('refuses a plan file with %s', (_, broken, message) => {
    expect(read({ ...fields(), ...broken })).toThrow(message);
  });

  it.each(['planned', 'after'])('reads back the %s values of an action, what is not known yet and exact numbers among them', (field) => {
    const values = { tags: { a: UNKNOWN, b: 'x' }, list: ['x', UNKNOWN], id: UNKNOWN, n: ExactNumber.parse('12345678901234567890') };
    const plan: Plan = { ...emptyPlan, actions: [{ type: 'CREATE', resourceType: 'x', name: 'a', attributes: {}, planned: {}, after: {}, [field]: values }] };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').actions[0]).toMatchObject({ [field]: values });
  });

  it.each([
    ['planned', 'a value that is not saved as one', { path: 'x' }],
    ['planned', 'no record of values', []],
    ['after', 'a value that is not saved as one', { path: 'x' }],
    ['after', 'no record of values', []],
  ])('refuses an action whose %s values hold %s', (field, _, values) => {
    const action = { type: 'CREATE', resourceType: 'x', name: 'a', attributes: {}, planned: {}, after: {}, [field]: values };

    expect(read({ ...fields(), actions: [action] })).toThrow('tfplan.json is not a plan file');
  });

  it.each(['CREATE', 'UPDATE', 'REPLACE'])('refuses a %s without the values it was planned with', (type) => {
    expect(read({ ...fields(), actions: [{ type, resourceType: 'x', name: 'a', attributes: {}, after: {} }] })).toThrow('tfplan.json is not a plan file');
  });

  it.each([
    ['DELETE', 'planned'],
    ['DELETE', 'after'],
    ['NO_OP', 'planned'],
    ['NO_OP', 'after'],
  ])('refuses a %s that carries %s values, since it sends none to a provider', (type, field) => {
    expect(read({ ...fields(), actions: [{ type, resourceType: 'x', name: 'a', [field]: {} }] })).toThrow('tfplan.json is not a plan file');
  });

  it.each(['CREATE', 'UPDATE', 'REPLACE'])('refuses a %s without what its provider planned', (type) => {
    expect(read({ ...fields(), actions: [{ type, resourceType: 'x', name: 'a', attributes: {}, planned: {} }] })).toThrow('tfplan.json is not a plan file');
  });

  it('names a serial that is not whole', () => {
    expect(read({ ...fields(), serial: 1.5 })).toThrow('tfplan.json is not a plan file: its serial: 1.5 is not a whole number');
  });

  it('names a position that is not whole', () => {
    const text = aPlanFile({
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        { type: 'CREATE', resourceType: 'null_resource', name: 'a', attributes: { n: { type: 'String', value: 'x', position: { file: 'main.clay', line: 1, column: 1 } } } },
      ],
      outputs: {},
    }).replace('"line": 1', '"line": 1.5');

    expect(() => parsePlanFile(text, 'tfplan.json')).toThrow("tfplan.json is not a plan file: a position's line: 1.5 is not a whole number");
  });

  it('names an index that is not whole', () => {
    const text = aPlanFile({
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      actions: [
        {
          type: 'CREATE',
          resourceType: 'null_resource',
          name: 'a',
          attributes: { n: { type: 'Reference', value: ['var', 'l', 1], position: { file: 'main.clay', line: 1, column: 1 } } },
        },
      ],
      outputs: {},
    }).replace(/"l",\s*1/, '"l", 1.5');

    expect(() => parsePlanFile(text, 'tfplan.json')).toThrow('tfplan.json is not a plan file: an index: 1.5 is not a whole number');
  });

  it('names the file when the text is not json', () => {
    expect(read('{oops')).toThrow('tfplan.json is not a plan file: the file is not JSON');
  });

  it('keeps the parser error as the cause, for whoever hand-edited the file', () => {
    expect(read('{oops')).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
  });

  // An older plan file is the most likely bad file, so it gets its own message.
  it('says so when the plan was written by another version', () => {
    expect(read({ ...fields(), version: '4.0' })).toThrow('tfplan.json was written by another Clay, plan version 4.0');
  });

  it.each([
    ['nothing at all', {}],
    ['no timestamp', { ...fields(), timestamp: undefined }],
    ['no config', { ...fields(), config: undefined }],
    ['modules that are not files', { ...fields(), modules: { 'm/main.clay': 1 } }],
    ['actions that are not a list', { ...fields(), actions: 'oops' }],
    ['outputs that are not a record', { ...fields(), outputs: 'oops' }],
    ['an action that is not a record', { ...fields(), actions: [null] }],
    ['an output change that is not a record', { ...fields(), outputs: { id: null } }],
    ['an action change that is not a record', { ...fields(), actions: [{ type: 'UPDATE', resourceType: 'a', name: 'b', changes: { x: 1 } }] }],
  ])('refuses %s', (_, content) => {
    expect(read(content)).toThrow('tfplan.json is not a plan file');
  });

  it.each([
    ['no schemas', undefined],
    ['a schema that is not a record', { x: 'oops' }],
    ['an attribute with no type', { x: { a: {} } }],
    ['an attribute of no type it knows', { x: { a: { type: { kind: 'tree' } } } }],
    ['a flag that is not a bool', { x: { a: { type: { kind: 'string' }, computed: 'yes' } } }],
    ['a collection with no element type', { x: { a: { type: { kind: 'set' } } } }],
    ['members of no type it knows', { x: { a: { type: { kind: 'set', element: { kind: 'tree' } } } } }],
    ['an object attribute of no type it knows', { x: { a: { type: { kind: 'object', attributes: { b: { kind: 'tree' } } } } } }],
    ['an object with no attributes', { x: { a: { type: { kind: 'object' } } } }],
    ['an optional list that is not a list', { x: { a: { type: { kind: 'object', attributes: { b: { kind: 'string' } }, optional: 'b' } } } }],
    ['an optional name that is not a string', { x: { a: { type: { kind: 'object', attributes: { 1: { kind: 'string' } }, optional: [1] } } } }],
    ['an optional attribute the object does not have', { x: { a: { type: { kind: 'object', attributes: {}, optional: ['b'] } } } }],
    ['a tuple with no elements', { x: { a: { type: { kind: 'tuple' } } } }],
    ['a tuple element of no type it knows', { x: { a: { type: { kind: 'tuple', elements: [{ kind: 'tree' }] } } } }],
  ])('refuses %s', (_, schemas) => {
    expect(read({ ...fields(), schemas })).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('reads back a schema with every kind of type, however deep', () => {
    const type = types.object(
      { ids: types.set(types.number), pairs: types.list(types.tuple([types.string, types.bool])), rest: types.map(types.dynamic), at: types.object({ x: types.number }) },
      ['rest']
    );
    const plan: Plan = { ...emptyPlan, schemas: { x: { a: { type, required: true } } } };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').schemas).toEqual(plan.schemas);
  });

  it.each([
    ['an action', { actions: [{ type: 'DELETE', resourceType: 'pool', name: 'a' }] }],
    ['the resources as state held them', { prevRun: { 'pool.a': { resourceType: 'pool', name: 'a', attributes: {} } } }],
    ['the resources as the refresh read them', { prior: { 'pool.a': { resourceType: 'pool', name: 'a', attributes: {} } } }],
  ])('refuses a resource type in %s that has no schema', (_, broken) => {
    expect(read({ ...fields(), ...broken })).toThrow('tfplan.json is not a plan file: it has no schema for pool');
  });
});
