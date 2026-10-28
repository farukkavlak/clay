import { ExactNumber, isUnknown, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { parsePlanFile, Plan, serializePlan } from '../src/index';

// Empty schemas: these tests are about the file, not the schemas.
const schemas = { null_resource: {}, x: {} };

const emptyPlan: Plan = { serial: 0, actions: [], outputs: {}, prevRun: {}, prior: {}, schemas, dataSources: {}, readAtApply: [] };

const aPlanFile = (plan: Plan = emptyPlan) => serializePlan(plan, { 'main.clay': '', 'm/main.clay': '' });

const fields = () => JSON.parse(aPlanFile()) as Record<string, unknown>;

const nested = (levels: number): unknown => (levels === 0 ? 'x' : [nested(levels - 1)]);

const read = (content: unknown) => () => parsePlanFile(typeof content === 'string' ? content : JSON.stringify(content), 'tfplan.json');

describe('reading a plan file', () => {
  // The file, its prior resources, the resource and its attributes are four levels around the value.
  it('reads a file nested 500 levels deep, and refuses one more', () => {
    const plan = (levels: number) => aPlanFile({ ...emptyPlan, prior: { 'x.a': { resourceType: 'x', name: 'a', attributes: { n: nested(levels - 4) } } } });

    expect(parsePlanFile(plan(500), 'tfplan.json').prior['x.a'].attributes.n).toEqual(nested(496));
    expect(read(plan(501))).toThrow('tfplan.json is not a plan file: it is nested more than 500 levels deep');
  });

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
      dataSources: {},
      readAtApply: [],
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
      dataSources: {},
      readAtApply: [],
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

  // The known parts stay exact, and the unknown parts come back where they were.
  it('reads a value known in part back as it was written', () => {
    const tags = { env: UNKNOWN, list: ['a', UNKNOWN], size: ExactNumber.parse('12345678901234567890'), unknown: [['env']] };
    const plan: Plan = {
      serial: 0,
      actions: [],
      outputs: { tags: { old: undefined, new: { value: tags, type: types.dynamic } } },
      prevRun: {},
      prior: {},
      schemas,
      dataSources: {},
      readAtApply: [],
    };

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
    ['a path through another written after it', [['list', 1], ['list']]],
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
      dataSources: {},
      readAtApply: [],
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
      dataSources: {},
      readAtApply: [],
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
    const plan: Plan = {
      serial: 0,
      actions: [{ type: 'DELETE', resourceType: 'null_resource', name: 'a', modulePath }],
      outputs: {},
      prevRun: {},
      prior: {},
      schemas,
      dataSources: {},
      readAtApply: [],
    };

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
    ['another type', 'local_file.x'],
    ['its own address', 'module.m[0].null_resource.a[0]'],
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

  it('reads a move from any other address of its type back as it was written', () => {
    const plan: Plan = {
      serial: 0,
      prevRun: {},
      prior: {},
      schemas,
      dataSources: {},
      readAtApply: [],
      actions: [
        { type: 'NO_OP', resourceType: 'null_resource', name: 'a', key: 0, movedFrom: 'null_resource.a' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'b', movedFrom: 'null_resource.b[0]' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'c', modulePath: [{ name: 'm', key: 1 }], key: 0, movedFrom: 'module.m[1].null_resource.c' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'd', modulePath: [{ name: 'm', key: 0 }], movedFrom: 'module.m.null_resource.d' },
        { type: 'NO_OP', resourceType: 'null_resource', name: 'e', modulePath: [{ name: 'm' }], movedFrom: 'module.m[0].null_resource.e[0]' },
        { type: 'DELETE', resourceType: 'null_resource', name: 'f', key: 'x', movedFrom: 'module.n.null_resource.g[1]' },
      ],
      outputs: {},
    };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').actions.map((action) => action.movedFrom)).toEqual([
      'null_resource.a',
      'null_resource.b[0]',
      'module.m[1].null_resource.c',
      'module.m.null_resource.d',
      'module.m[0].null_resource.e[0]',
      'module.n.null_resource.g[1]',
    ]);
  });

  it('names an instance key that is not whole', () => {
    expect(read(keyed(1.5))).toThrow('tfplan.json is not a plan file: an instance key: 1.5 is not a whole number');
  });

  it.each([
    ['anything but true', 'NO_OP', 'yes'],
    ['false', 'NO_OP', false],
    ['on a delete', 'DELETE', true],
  ])('refuses a change in which parts are sensitive that is %s', (_, type, marksChange) => {
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', marksChange }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['anything but true', 'NO_OP', 'yes'],
    ['false', 'NO_OP', false],
    ['on an update', 'UPDATE', true],
  ])('refuses a change in whether a destroy is prevented that is %s', (_, type, protectionChange) => {
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', protectionChange }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['anything but true', 'NO_OP', 'yes'],
    ['false', 'NO_OP', false],
    ['on an update', 'UPDATE', true],
  ])('refuses a change in what runs before a destroy that is %s', (_, type, provisionersChange) => {
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', provisionersChange }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['anything but true', 'NO_OP', false],
    ['on a delete', 'DELETE', true],
  ])('refuses prevent_destroy that is %s', (_, type, preventDestroy) => {
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', preventDestroy }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['on a create', 'CREATE', [['content']]],
    ['on a no-op', 'NO_OP', [['content']]],
    ['on a delete', 'DELETE', [['content']]],
    ['that are not steps', 'UPDATE', 'content'],
  ])('refuses ignored paths %s', (_, type, ignored) => {
    const withValues = type === 'UPDATE' ? { planned: {}, after: {} } : {};
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', ignored, ...withValues }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('names an ignored index that is not whole', () => {
    const content = { ...fields(), actions: [{ type: 'UPDATE', resourceType: 'null_resource', name: 'a', planned: {}, after: {}, ignored: [['items', 1.5]] }] };

    expect(read(content)).toThrow('tfplan.json is not a plan file: an ignored index: 1.5 is not a whole number');
  });

  it.each([
    ['anything but true', 'DELETE', false],
    ['on an update', 'UPDATE', true],
    ['on a no-op', 'NO_OP', true],
  ])('refuses deposed that is %s', (_, type, deposed) => {
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', deposed }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['anything but true', 'REPLACE', false],
    ['on an update', 'UPDATE', true],
    ['on a delete', 'DELETE', true],
    ['on a create', 'CREATE', true],
  ])('refuses create_before_destroy that is %s', (_, type, createBeforeDestroy) => {
    const withValues = type === 'REPLACE' || type === 'UPDATE' || type === 'CREATE' ? { planned: {}, after: {} } : {};
    const content = { ...fields(), actions: [{ type, resourceType: 'null_resource', name: 'a', createBeforeDestroy, ...withValues }] };

    expect(read(content)).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('names a sensitive index that is not whole', () => {
    const content = { ...fields(), actions: [{ type: 'NO_OP', resourceType: 'null_resource', name: 'a', sensitive: [['triggers', 1.5]] }] };

    expect(read(content)).toThrow('tfplan.json is not a plan file: a sensitive index: 1.5 is not a whole number');
  });

  describe('the sensitive parts of what a data source read', () => {
    const address = 'data.local_file.f';
    const gave = { path: { value: 'a', type: types.string }, tags: { value: ['x', 'y'], type: types.list(types.string) } };

    it('reads them back, an index as a plain number', () => {
      const plan: Plan = { ...emptyPlan, dataSources: { [address]: gave }, dataSensitive: { [address]: [['path'], ['tags', 1]] } };

      expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').dataSensitive).toEqual({ [address]: [['path'], ['tags', 1]] });
    });

    it('leaves them out of a plan that has none', () => {
      expect(JSON.parse(aPlanFile())).not.toHaveProperty('dataSensitive');
    });

    it.each([
      ['paths that are not a list', { [address]: 'path' }],
      ['a path with a step that is no key or index', { [address]: [[true]] }],
    ])('refuses a plan file with %s', (_, dataSensitive) => {
      expect(read({ ...fields(), dataSources: { [address]: gave }, dataSensitive })).toThrow(/^tfplan\.json is not a plan file$/);
    });

    it('names a sensitive index that is not whole', () => {
      expect(read({ ...fields(), dataSources: { [address]: gave }, dataSensitive: { [address]: [['tags', 1.5]] } })).toThrow(
        'tfplan.json is not a plan file: a sensitive index: 1.5 is not a whole number'
      );
    });

    it('refuses sensitive parts of a data source the plan holds no value for', () => {
      expect(read({ ...fields(), dataSensitive: { [address]: [['path']] } })).toThrow(
        'tfplan.json is not a plan file: "data.local_file.f" has sensitive parts but no value in the plan'
      );
    });
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
    ['no list of data sources the apply reads', { readAtApply: undefined }, /^tfplan\.json is not a plan file$/],
    ['a data source the apply reads that is not an address', { readAtApply: [1] }, /^tfplan\.json is not a plan file$/],
    [
      'a data source the apply reads under a name that is no address',
      { readAtApply: ['data.local_file'] },
      'tfplan.json is not a plan file: "data.local_file" is not a data source: a data source is named data, its type and its name',
    ],
    [
      'a data source in a module whose key is not written as one',
      { readAtApply: ['module.m[x].data.local_file.f'] },
      'tfplan.json is not a plan file: "module.m[x].data.local_file.f" is not a data source: a key is a whole number or a quoted string, as in [0] or ["name"]',
    ],
    [
      'a data source it read under a name that is no address',
      { dataSources: { 'local_file.f': {} } },
      'tfplan.json is not a plan file: "local_file.f" is not a data source: a data source is named data, its type and its name',
    ],
    [
      'a data source both read and left for the apply',
      { dataSources: { 'data.local_file.f': {} }, readAtApply: ['data.local_file.f'] },
      'tfplan.json is not a plan file: "data.local_file.f" is both read and left for the apply',
    ],
  ])('refuses a plan file with %s', (_, broken, message) => {
    expect(read({ ...fields(), ...broken })).toThrow(message);
  });

  it.each(['planned', 'after'])('reads back the %s values of an action, what is not known yet and exact numbers among them', (field) => {
    const values = { tags: { a: UNKNOWN, b: 'x' }, list: ['x', UNKNOWN], id: UNKNOWN, n: ExactNumber.parse('12345678901234567890') };
    const plan: Plan = { ...emptyPlan, actions: [{ type: 'CREATE', resourceType: 'x', name: 'a', planned: {}, after: {}, [field]: values }] };

    expect(parsePlanFile(aPlanFile(plan), 'tfplan.json').actions[0]).toMatchObject({ [field]: values });
  });

  it.each([
    ['planned', 'a value that is not saved as one', { path: 'x' }],
    ['planned', 'no record of values', []],
    ['after', 'a value that is not saved as one', { path: 'x' }],
    ['after', 'no record of values', []],
  ])('refuses an action whose %s values hold %s', (field, _, values) => {
    const action = { type: 'CREATE', resourceType: 'x', name: 'a', planned: {}, after: {}, [field]: values };

    expect(read({ ...fields(), actions: [action] })).toThrow('tfplan.json is not a plan file');
  });

  it.each(['CREATE', 'UPDATE', 'REPLACE'])('refuses a %s without the values it was planned with', (type) => {
    expect(read({ ...fields(), actions: [{ type, resourceType: 'x', name: 'a', after: {} }] })).toThrow('tfplan.json is not a plan file');
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
    expect(read({ ...fields(), actions: [{ type, resourceType: 'x', name: 'a', planned: {} }] })).toThrow('tfplan.json is not a plan file');
  });

  it.each([
    ['no resource type', { resourceType: undefined }],
    ['a name that is a number', { name: 5 }],
    ['an action type that is none', { type: 'MAKE' }],
    ['a dependency that is a number', { dependencies: [42] }],
    ['a dependency that is not an address', { dependencies: ['nothing'] }],
  ])('refuses an action with %s', (_, broken) => {
    const action = { type: 'DELETE', resourceType: 'x', name: 'a', ...broken };

    expect(read({ ...fields(), actions: [action] })).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('refuses a schema whose sensitive flag is not true or false', () => {
    const schemas = { x: { path: { type: { kind: 'string' }, sensitive: 'yes' } } };

    expect(read({ ...fields(), schemas })).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it('names a serial that is not whole', () => {
    expect(read({ ...fields(), serial: 1.5 })).toThrow('tfplan.json is not a plan file: its serial: 1.5 is not a whole number');
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
    ['a timestamp in a form Clay does not write', { ...fields(), timestamp: '2024-01-01T00:00:00Z' }],
    ['a timestamp that is no time', { ...fields(), timestamp: 'now' }],
    ['an output no configuration can declare', { ...fields(), outputs: { 'a b': { old: undefined, new: { type: { kind: 'string' }, value: 'v' } } } }],
    ['no files', { ...fields(), files: undefined }],
    ['files that are not text', { ...fields(), files: { 'main.clay': '', 'm/main.clay': 1 } }],
    ['no file at the root', { ...fields(), files: { 'm/main.clay': '' } }],
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

  it('reads back what each data source gave, its types and exact numbers among them', () => {
    const dataSources = {
      'data.local_file.f': { content: { value: 'x', type: types.string }, sizes: { value: [ExactNumber.parse('12345678901234567890')], type: types.set(types.number) } },
      'module.m[0].data.local_file.f': { content: { value: null, type: types.string } },
    };

    expect(parsePlanFile(aPlanFile({ ...emptyPlan, dataSources }), 'tfplan.json').dataSources).toEqual(dataSources);
  });

  it.each([
    ['no data sources', undefined],
    ['data sources that are a list', []],
    ['a data source that is a list', { 'local_file.f': [] }],
    ['a data source that is null', { 'local_file.f': null }],
    ['an attribute with no type', { 'local_file.f': { content: { value: 'x' } } }],
    ['an attribute with no value', { 'local_file.f': { content: { type: { kind: 'string' } } } }],
    ['an attribute of no type it knows', { 'local_file.f': { content: { value: 'x', type: { kind: 'tree' } } } }],
  ])('refuses %s', (_, dataSources) => {
    expect(read({ ...fields(), dataSources })).toThrow(/^tfplan\.json is not a plan file$/);
  });

  it.each([
    ['an action', { actions: [{ type: 'DELETE', resourceType: 'pool', name: 'a' }] }],
    ['the resources as state held them', { prevRun: { 'pool.a': { resourceType: 'pool', name: 'a', attributes: {} } } }],
    ['the resources as the refresh read them', { prior: { 'pool.a': { resourceType: 'pool', name: 'a', attributes: {} } } }],
  ])('refuses a resource type in %s that has no schema', (_, broken) => {
    expect(read({ ...fields(), ...broken })).toThrow('tfplan.json is not a plan file: it has no schema for pool');
  });
});
