import { Schema } from '@clay/contracts';
import { ConfigError, spell } from '@clay/parser';

import { LoadedResource } from './components/ModuleLoader';
import { withPlace } from './place';

/** A value only the provider makes would show in the plan as the configuration set it and then never be applied. */
export function refuseComputedSet(loaded: LoadedResource[], schemas: Map<string, Schema>): void {
  for (const { block, address } of loaded) {
    const schema = schemas.get(block.resourceType) ?? {};

    for (const [name, value] of Object.entries(block.attributes)) {
      const definition = Object.hasOwn(schema, name) ? schema[name] : undefined;
      if (!definition?.computed || definition.optional) continue;

      const error = new ConfigError(`${name} is computed by ${block.resourceType} and cannot be set`, value.position);
      throw withPlace(error, value.position, spell(block), address);
    }
  }
}
