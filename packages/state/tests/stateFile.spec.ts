import { emptyState, ExactNumber, STATE_VERSION } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { parseState, serializeState } from '../src/stateFile';

const read = (content: unknown) => () => parseState(typeof content === 'string' ? content : JSON.stringify(content), 'clay.state.json');

describe('reading a state file', () => {
  it('reads back what it wrote', () => {
    const state = { ...emptyState(), serial: 3, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } } } };

    expect(parseState(serializeState(state), 'clay.state.json')).toEqual(state);
  });

  // Counters are plain numbers; values stay exact.
  it('reads its counters as numbers and every value exactly', () => {
    const text = `{"version": ${STATE_VERSION}, "serial": 3, "resources": {"null_resource.a": {"resourceType": "null_resource", "name": "a", "attributes": {"id": 12345678901234567890}}}}`;

    const state = parseState(text, 'clay.state.json');

    expect(state.serial).toBe(3);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.resources['null_resource.a'].attributes.id).toEqual(ExactNumber.parse('12345678901234567890'));
  });

  it.each([
    ['a number', 'local_file.a[0]', '0', 0],
    ['a string', 'local_file.a["blog"]', '"blog"', 'blog'],
  ])('reads an instance key that is %s', (_, address, written, key) => {
    const text = `{"version": ${STATE_VERSION}, "serial": 0, "resources": {${JSON.stringify(address)}: {"resourceType": "local_file", "name": "a", "key": ${written}, "attributes": {}}}}`;

    expect(parseState(text, 'clay.state.json').resources[address].key).toBe(key);
  });

  it.each([
    ['a number', 'module.m[0].local_file.a', '0', 0],
    ['a string', 'module.m["blog"].local_file.a', '"blog"', 'blog'],
  ])('reads a module key that is %s', (_, address, written, key) => {
    const text = `{"version": ${STATE_VERSION}, "serial": 0, "resources": {${JSON.stringify(address)}: {"resourceType": "local_file", "name": "a", "modulePath": [{"name": "m", "key": ${written}}], "attributes": {}}}}`;

    expect(parseState(text, 'clay.state.json').resources[address].modulePath).toEqual([{ name: 'm', key }]);
  });

  it('names a module key that is not whole', () => {
    const text = `{"version": ${STATE_VERSION}, "serial": 0, "resources": {"module.m[0].local_file.a": {"resourceType": "local_file", "name": "a", "modulePath": [{"name": "m", "key": 1.5}], "attributes": {}}}}`;

    expect(read(text)).toThrow('clay.state.json is not valid state: a module key of "module.m[0].local_file.a": 1.5 is not a whole number');
  });

  it.each([
    ['1.5', 'is not a whole number'],
    ['-1', 'is not a key: a key is a whole number or a string'],
    ['9007199254740992', 'is outside the range'],
    ['true', 'is not a key: a key is a whole number or a string'],
  ])('refuses an instance key of %s', (written, problem) => {
    const text = `{"version": ${STATE_VERSION}, "serial": 0, "resources": {"local_file.a[0]": {"resourceType": "local_file", "name": "a", "key": ${written}, "attributes": {}}}}`;

    expect(read(text)).toThrow(`clay.state.json is not valid state: the key of "local_file.a[0]"`);
    expect(read(text)).toThrow(problem);
  });

  it.each([
    ['another name', 'local_file.a', { resourceType: 'local_file', name: 'b' }, 'local_file.b'],
    ['another type', 'local_file.a', { resourceType: 'null_resource', name: 'a' }, 'null_resource.a'],
    ['another module', 'module.m.local_file.a', { resourceType: 'local_file', name: 'a', modulePath: [{ name: 'n' }] }, 'module.n.local_file.a'],
    ['another module instance', 'module.m[0].local_file.a', { resourceType: 'local_file', name: 'a', modulePath: [{ name: 'm', key: 1 }] }, 'module.m[1].local_file.a'],
    ['a key', 'local_file.a', { resourceType: 'local_file', name: 'a', key: 0 }, 'local_file.a[0]'],
  ])('refuses an entry filed under an address other than its own, by %s', (_, address, entry, held) => {
    const content = { version: STATE_VERSION, serial: 0, resources: { [address]: { ...entry, attributes: {} } } };

    expect(read(content)).toThrow(`clay.state.json is not valid state: "${address}" holds ${held}`);
  });

  it('names a number out of range, rather than calling the file something other than JSON', () => {
    expect(read(`{"version": ${STATE_VERSION}, "serial": 0, "resources": {}, "outputs": {"o": 1e5000}}`)).toThrow(
      'clay.state.json is not valid state: "1e5000" is out of range: a number reaches at most 1000 places either side of the point'
    );
  });

  it('names the counter that is not whole', () => {
    expect(read({ version: STATE_VERSION, serial: 1.5, resources: {} })).toThrow('clay.state.json is not valid state: its serial: 1.5 is not a whole number');
  });

  it('names the file when the text is not json', () => {
    expect(read('{oops')).toThrow('clay.state.json is not valid state: the file is not JSON');
  });

  // These used to be accepted, and a string `resources` planned a delete per character.
  it.each([
    ['nothing at all', {}],
    ['a version that is not a number', { version: '1', serial: 0, resources: {} }],
    ['no serial', { version: STATE_VERSION, resources: {} }],
    ['resources that are not a record', { version: STATE_VERSION, serial: 0, resources: 'oops' }],
    ['a resource that is not an object', { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': 'oops' } }],
    ['a resource with no type', { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': { name: 'a', attributes: {} } } }],
    ['a resource with no name', { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', attributes: {} } } }],
    ['a resource with no attributes', { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a' } } }],
    // An ExactNumber is an object, but not a record.
    ['attributes that are a number', { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: 5 } } }],
    ['outputs that are a number', { version: STATE_VERSION, serial: 0, outputs: 5, resources: {} }],
    ['a serial that is not whole', { version: STATE_VERSION, serial: 1.5, resources: {} }],
    [
      'dependencies that are not a list',
      { version: STATE_VERSION, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {}, dependencies: 'b' } } },
    ],
    ['outputs that are not a record', { version: STATE_VERSION, serial: 0, outputs: 'oops', resources: {} }],
  ])('refuses %s', (_, content) => {
    expect(read(content)).toThrow(/clay\.state\.json is not valid state/);
  });

  it.each([
    ['a bare value', 'hello'],
    ['a value with no type', { value: 'hello' }],
    ['a type with no value', { type: { kind: 'string' } }],
    ['a type that is none', { value: 'hello', type: { kind: 'text' } }],
  ])('refuses an output that is %s', (_, output) => {
    const content = { version: STATE_VERSION, serial: 0, resources: {}, outputs: { o: output } };

    expect(read(content)).toThrow('clay.state.json is not valid state: its output "o" is not a value with its type');
  });

  it('reads an output of null, which is a value', () => {
    const outputs = { o: { value: null, type: { kind: 'dynamic' } } };

    expect(read({ version: STATE_VERSION, serial: 0, resources: {}, outputs })().outputs).toEqual(outputs);
  });

  // A later check would also refuse the entry, so the test pins the message.
  it.each([
    ['text', 'local_file.a', 'm'],
    ['a list that holds no names', 'module.1.local_file.a', [1]],
    ['a list of bare names', 'module.m.local_file.a', ['m']],
    ['a module key that is no key', 'module.m[-1].local_file.a', [{ name: 'm', key: -1 }]],
  ])('refuses a module path that is %s', (_, address, modulePath) => {
    const content = { version: STATE_VERSION, serial: 0, resources: { [address]: { resourceType: 'local_file', name: 'a', modulePath, attributes: {} } } };

    expect(read(content)).toThrow(`clay.state.json is not valid state: "${address}" is not a resource`);
  });

  it('refuses a state a newer Clay wrote, since it cannot know what changed', () => {
    expect(read({ version: STATE_VERSION + 1, serial: 0, resources: {} })).toThrow(`clay.state.json was written by a newer Clay, version ${STATE_VERSION + 1}`);
  });

  // An older state kept the id outside the attributes; reading it now would silently lose every id.
  it('refuses a state an older Clay wrote', () => {
    expect(read({ version: STATE_VERSION - 1, serial: 0, resources: {} })).toThrow(`clay.state.json was written by an older Clay, version ${STATE_VERSION - 1}`);
  });

  it('keeps the parser error as the cause, for whoever hand-edited the file', () => {
    expect(read('{oops')).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
  });

  it('keeps a resource attribute it has no opinion about', () => {
    const resources = { 'module.m.local_file.a': { id: 'x', resourceType: 'local_file', name: 'a', modulePath: [{ name: 'm' }], attributes: {}, dependencies: ['local_file.b'] } };

    expect(parseState(JSON.stringify({ version: STATE_VERSION, serial: 0, resources }), 'f').resources).toEqual(resources);
  });
});
