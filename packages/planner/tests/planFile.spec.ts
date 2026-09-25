import { ExactNumber } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { isUnknown, parsePlanFile, Plan, serializePlan, UNKNOWN } from '../src/index';

const emptyPlan: Plan = { serial: 0, actions: [], outputs: {} };

const aPlanFile = (plan: Plan = emptyPlan) => serializePlan(plan, 'resource "a" "b" {}', { 'm/main.clay': '' });

/** The file as JSON, for a test that has to break one of its fields. */
const fields = () => JSON.parse(aPlanFile()) as Record<string, unknown>;

const read = (content: unknown) => () => parsePlanFile(typeof content === 'string' ? content : JSON.stringify(content), 'tfplan.json');

describe('reading a plan file', () => {
  // Built once: `serializePlan` stamps the time, so two calls disagree whenever the clock ticks between them.
  it('reads back what it wrote', () => {
    const written = aPlanFile();

    expect(parsePlanFile(written, 'tfplan.json')).toEqual(JSON.parse(written));
  });

  // A value not known yet has no form in JSON, so it has to come back as itself and not as whatever it was written as.
  it('reads a value that is not known yet back as one, in an action and in an output', () => {
    const plan: Plan = {
      serial: 0,
      actions: [{ type: 'UPDATE', resourceType: 'null_resource', name: 'a', changes: { triggers: { old: 'x', new: UNKNOWN } } }],
      outputs: { id: { old: undefined, new: UNKNOWN } },
    };

    const read = parsePlanFile(aPlanFile(plan), 'tfplan.json');

    expect(isUnknown(read.actions[0].changes!.triggers.new)).toBe(true);
    expect(read.actions[0].changes!.triggers.old).toBe('x');
    expect(isUnknown(read.outputs.id.new)).toBe(true);
  });

  it('reads a map that only looks like the unknown marker back as that map', () => {
    const lookalike = { '@@clay/unknown': true };
    const plan: Plan = {
      serial: 0,
      actions: [{ type: 'UPDATE', resourceType: 'null_resource', name: 'a', changes: { triggers: { old: {}, new: lookalike } } }],
      outputs: {},
    };

    const change = parsePlanFile(aPlanFile(plan), 'tfplan.json').actions[0].changes!.triggers;

    expect(isUnknown(change.new)).toBe(false);
    expect(change.new).toEqual(lookalike);
  });

  // A saved action carries its attributes as parsed; a value in them is exact, while where it was written stays a JavaScript number.
  it('reads the positions in saved attributes as numbers, and the values in them exactly, however deep', () => {
    const at = { file: 'main.clay', line: 3, column: 7 };
    const plan: Plan = {
      serial: 4,
      actions: [
        {
          type: 'CREATE',
          resourceType: 'null_resource',
          name: 'a',
          attributes: {
            id: { type: 'Number', value: ExactNumber.parse('12345678901234567890'), position: at },
            tags: { type: 'List', value: [{ type: 'Map', value: { n: { type: 'Number', value: ExactNumber.parse('1'), position: at } }, position: at }], position: at },
            label: { type: 'Template', value: ['id ', { type: 'Reference', value: ['var', 'id'], position: at }], position: at },
          },
        },
      ],
      outputs: {},
    };

    const read = parsePlanFile(aPlanFile(plan), 'tfplan.json');

    expect(read.serial).toBe(4);
    expect(read.actions[0].attributes).toEqual(plan.actions[0].attributes);
  });

  it('refuses to write a value not known yet from inside another value, rather than drop it', () => {
    const plan: Plan = { serial: 0, actions: [], outputs: { tags: { old: undefined, new: { env: UNKNOWN } } } };

    expect(() => aPlanFile(plan)).toThrow('A value not known yet sits inside another value, where a plan file cannot hold it');
  });

  it('keeps a change whose name every object has, rather than setting a prototype', () => {
    const plan: Plan = { serial: 0, actions: [], outputs: JSON.parse('{"__proto__": {"old": "a", "new": "b"}}') };

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

  it('names a serial that is not whole', () => {
    expect(read({ ...fields(), serial: 1.5 })).toThrow('tfplan.json is not a plan file: its serial: 1.5 is not a whole number');
  });

  it('names a position that is not whole', () => {
    const text = aPlanFile({
      serial: 0,
      actions: [
        { type: 'CREATE', resourceType: 'null_resource', name: 'a', attributes: { n: { type: 'String', value: 'x', position: { file: 'main.clay', line: 1, column: 1 } } } },
      ],
      outputs: {},
    }).replace('"line": 1', '"line": 1.5');

    expect(() => parsePlanFile(text, 'tfplan.json')).toThrow("tfplan.json is not a plan file: a position's line: 1.5 is not a whole number");
  });

  it('names the file when the text is not json', () => {
    expect(read('{oops')).toThrow('tfplan.json is not a plan file: the file is not JSON');
  });

  it('keeps the parser error as the cause, for whoever hand-edited the file', () => {
    expect(read('{oops')).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
  });

  // A plan file from an older Clay is the one a user is most likely to meet, and it deserves to be told apart from a broken one.
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
});
