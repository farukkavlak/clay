import { Address, isAddress, isInstanceKey, isModulePath } from './Address';
import { isAttributePaths, readPaths } from './AttributePath';
import { ExactNumber, NumberError } from './ExactNumber';
import { isRecord } from './isRecord';
import type { DeposedObject, Resource } from './State';

/** The blocks an object was made after, whose objects its delete must come before. A dependency names no instance of its block. */
export function isDependencies(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((address) => typeof address === 'string' && isAddress(address) && Address.parse(address).key === undefined));
}

/** What a resource keeps beside its values, each left out where there is none. */
function isKeptBesideValues(value: Record<string, unknown>): boolean {
  return (
    (value.sensitive === undefined || isAttributePaths(value.sensitive)) &&
    (value.preventDestroy === undefined || value.preventDestroy === true) &&
    isDependencies(value.dependencies)
  );
}

/** Checks what the engine reads without asking: the address fields, `attributes`, `sensitive`, `preventDestroy` and `dependencies`. */
function isResource(value: unknown): value is Resource {
  return (
    isRecord(value) &&
    typeof value.resourceType === 'string' &&
    typeof value.name === 'string' &&
    (value.modulePath === undefined || isModulePath(value.modulePath)) &&
    isRecord(value.attributes) &&
    isKeptBesideValues(value)
  );
}

/** Instance keys are part of the address and indexes in sensitive paths are steps, so both read back as plain numbers. */
function readKeys(resources: Record<string, unknown>): void {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isRecord(resource)) continue;

    if (resource.key instanceof ExactNumber) resource.key = resource.key.toSafeInteger(`the key of "${address}"`);
    if (resource.sensitive !== undefined) resource.sensitive = readPaths(resource.sensitive, `a sensitive index of "${address}"`);
    if (Array.isArray(resource.modulePath))
      for (const step of resource.modulePath) if (isRecord(step) && step.key instanceof ExactNumber) step.key = step.key.toSafeInteger(`a module key of "${address}"`);
  }
}

function checkResources(resources: Record<string, unknown>, say: (problem: string) => never): asserts resources is Record<string, Resource> {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isResource(resource)) say(`"${address}" is not a resource`);
    if (resource.key !== undefined && !isInstanceKey(resource.key)) say(`the key of "${address}" is not a key: a key is a whole number or a string`);
    Address.parse(address, (reason) => say(`"${address}" is not the address of a resource: ${reason}`));

    // Lookups use the key, but a delete is built from the entry's own fields, so they must agree.
    const held = Address.of(resource).toString();
    if (held !== address) say(`"${address}" holds ${held}`);
  }
}

function isDeposedObject(value: unknown): value is DeposedObject {
  return isRecord(value) && isRecord(value.attributes) && (value.sensitive === undefined || isAttributePaths(value.sensitive)) && isDependencies(value.dependencies);
}

function readDeposedPaths(object: unknown, address: string, say: (problem: string) => never): void {
  if (!isRecord(object) || object.sensitive === undefined) return;

  try {
    object.sensitive = readPaths(object.sensitive, `a sensitive index of a deposed object of "${address}"`);
  } catch (error) {
    if (error instanceof NumberError) say(error.message);

    throw error;
  }
}

/** Read with exact numbers like the resources, then checked: each address is one, and each object holds attributes. */
export function readDeposed(deposed: unknown, say: (problem: string) => never): asserts deposed is Record<string, DeposedObject[]> | undefined {
  if (deposed === undefined) return;
  if (!isRecord(deposed)) say('its deposed objects are not a record');

  for (const [address, objects] of Object.entries(deposed)) {
    if (!isAddress(address)) say(`"${address}" is not the address of a resource, so it cannot hold deposed objects`);
    if (!Array.isArray(objects) || objects.length === 0) say(`the deposed objects of "${address}" are not a list with an object in it`);

    for (const object of objects as unknown[]) {
      readDeposedPaths(object, address, say);
      if (!isDeposedObject(object)) say(`a deposed object of "${address}" has no attributes, or its sensitive or dependencies are not what they should be`);
    }
  }
}

/** Resources from a state or plan file, read with exact numbers: keys and sensitive indexes become plain numbers, then each resource is checked. */
export function readResources(resources: unknown, field: string, say: (problem: string) => never): asserts resources is Record<string, Resource> {
  if (!isRecord(resources)) say(`${field} are not a record`);

  try {
    readKeys(resources);
  } catch (error) {
    if (error instanceof NumberError) say(error.message);

    throw error;
  }

  checkResources(resources, say);
}
