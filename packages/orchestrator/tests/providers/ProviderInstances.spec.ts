import { Provider } from '@clay/provider';
import { describe, expect, it } from 'vitest';

import { Limit } from '../../src/providers/Limit';
import { ProviderInstances } from '../../src/providers/ProviderInstances';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { DEFAULT_PARALLELISM } from '../../src/run/parallelism';

// Only what the registry reads; nothing else is asked.
const make = () => ({ name: 'p', resources: ['p_thing'], dataSources: [] }) as unknown as Provider;

describe('ProviderInstances', () => {
  // The walk configures a provider before every block of its types, so this is never met unless the graph is wrong.
  it('refuses a provider asked before it is configured', () => {
    const registry = new ProviderRegistry();
    registry.register(make);

    expect(() => new ProviderInstances(registry, new Map(), new Limit(DEFAULT_PARALLELISM)).get({ resourceType: 'p_thing' })).toThrow(
      'provider "p" is asked before it is configured, which is a bug in Clay'
    );
  });
});
