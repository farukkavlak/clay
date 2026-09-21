import { describe, expect, it } from 'vitest';

import { parsePlanFile, serializePlan } from '../src/index';

const aPlanFile = () => serializePlan({ serial: 0, actions: [], outputs: {} }, 'resource "a" "b" {}', { 'm/main.clay': '' });

const read = (content: unknown) => () => parsePlanFile(typeof content === 'string' ? content : JSON.stringify(content), 'tfplan.json');

describe('reading a plan file', () => {
  // Built once: `serializePlan` stamps the time, so two calls disagree whenever the clock ticks between them.
  it('reads back what it wrote', () => {
    const written = aPlanFile();

    expect(parsePlanFile(JSON.stringify(written), 'tfplan.json')).toEqual(written);
  });

  it('names the file when the text is not json', () => {
    expect(read('{oops')).toThrow('tfplan.json is not a plan file: the file is not JSON');
  });

  it('keeps the parser error as the cause, for whoever hand-edited the file', () => {
    expect(read('{oops')).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }));
  });

  // A plan file from an older Clay is the one a user is most likely to meet, and it deserves to be told apart from a broken one.
  it('says so when the plan was written by another version', () => {
    expect(read({ ...aPlanFile(), version: '4.0' })).toThrow('tfplan.json was written by another Clay, plan version 4.0');
  });

  it.each([
    ['nothing at all', {}],
    ['no timestamp', { ...aPlanFile(), timestamp: undefined }],
    ['no config', { ...aPlanFile(), config: undefined }],
    ['modules that are not files', { ...aPlanFile(), modules: { 'm/main.clay': 1 } }],
    ['actions that are not a list', { ...aPlanFile(), actions: 'oops' }],
    ['outputs that are not a record', { ...aPlanFile(), outputs: 'oops' }],
  ])('refuses %s', (_, content) => {
    expect(read(content)).toThrow('tfplan.json is not a plan file');
  });
});
