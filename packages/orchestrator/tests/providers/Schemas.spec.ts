import { types } from '@clay/provider';
import { describe, expect, it } from 'vitest';

import { Schemas } from '../../src/providers/Schemas';

describe('Schemas', () => {
  it('gives the schema loaded for a type', () => {
    const schemas = new Schemas();
    schemas.resources.set('local_file', { path: { type: types.string } });

    expect(schemas.resources.get('local_file')).toEqual({ path: { type: types.string } });
  });

  // Loading fails the run first, so only a bug in the engine asks for one never loaded.
  it('refuses a type whose schema is not loaded, naming its kind', () => {
    const schemas = new Schemas();
    schemas.resources.set('local_file', {});

    expect(() => schemas.dataSources.get('local_file')).toThrow('no schema is loaded for data source type "local_file", which is a bug');
  });
});
