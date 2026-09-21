import { emptyState, STATE_VERSION } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { parseState, serializeState } from '../src/stateFile';

const read = (content: unknown) => () => parseState(typeof content === 'string' ? content : JSON.stringify(content), 'clay.state.json');

describe('reading a state file', () => {
  it('reads back what it wrote', () => {
    const state = { ...emptyState(), serial: 3, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } } } };

    expect(parseState(serializeState(state), 'clay.state.json')).toEqual(state);
  });

  it('names the file when the text is not json', () => {
    expect(read('{oops')).toThrow('clay.state.json is not valid state: the file is not JSON');
  });

  // Every one of these read as a state before, and a `resources` that is not a record planned a delete per character.
  it.each([
    ['nothing at all', {}],
    ['a version that is not a number', { version: '1', serial: 0, resources: {} }],
    ['no serial', { version: 1, resources: {} }],
    ['resources that are not a record', { version: 1, serial: 0, resources: 'oops' }],
    ['a resource that is not an object', { version: 1, serial: 0, resources: { 'local_file.a': 'oops' } }],
    ['a resource with no type', { version: 1, serial: 0, resources: { 'local_file.a': { name: 'a', attributes: {} } } }],
    ['a resource with no name', { version: 1, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', attributes: {} } } }],
    ['a resource with no attributes', { version: 1, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a' } } }],
    ['dependencies that are not a list', { version: 1, serial: 0, resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {}, dependencies: 'b' } } }],
    ['outputs that are not a record', { version: 1, serial: 0, outputs: 'oops', resources: {} }],
  ])('refuses %s', (_, content) => {
    expect(read(content)).toThrow(/clay\.state\.json is not valid state/);
  });

  it('refuses a state a newer Clay wrote, since it cannot know what changed', () => {
    expect(read({ version: STATE_VERSION + 1, serial: 0, resources: {} })).toThrow(`clay.state.json was written by a newer Clay, version ${STATE_VERSION + 1}`);
  });

  it('keeps the parser error as the cause, for whoever hand-edited the file', () => {
    expect(read('{oops')).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
  });

  it('keeps a resource attribute it has no opinion about', () => {
    const resources = { 'local_file.a': { id: 'x', resourceType: 'local_file', name: 'a', modulePath: ['m'], attributes: {}, dependencies: ['local_file.b'] } };

    expect(parseState(JSON.stringify({ version: 1, serial: 0, resources }), 'f').resources).toEqual(resources);
  });
});
