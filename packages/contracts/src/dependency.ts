import { Address } from './Address';

/**
 * A dependency names a block, with no key, and the module instances its reader shares with it: a module step with a key is that instance,
 * one without is every instance. So an object keeps one for each block it read, however many instances the block has.
 */
export function covers(dependency: Address, object: Address): boolean {
  const steps = dependency.module.path;
  const at = object.module.path;
  if (dependency.resourceType !== object.resourceType || dependency.name !== object.name || steps.length !== at.length) return false;

  return steps.every((step, index) => step.name === at[index].name && (step.key === undefined || step.key === at[index].key));
}
