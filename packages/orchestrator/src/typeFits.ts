import { Type } from '@clay/contracts';

type Fits = (planned: Type, actual: Type) => boolean;

function objectFits(planned: Extract<Type, { kind: 'object' }>, actual: Type, fits: Fits): boolean {
  if (actual.kind !== 'object') return false;

  const names = Object.keys(planned.attributes);
  return (
    names.length === Object.keys(actual.attributes).length &&
    names.every((name) => Object.hasOwn(actual.attributes, name) && fits(planned.attributes[name], actual.attributes[name]))
  );
}

function tupleFits(planned: Extract<Type, { kind: 'tuple' }>, actual: Type, fits: Fits): boolean {
  return actual.kind === 'tuple' && planned.elements.length === actual.elements.length && planned.elements.every((element, index) => fits(element, actual.elements[index]));
}

/** Whether a value of type `actual` is what a plan that held `planned` showed. A part the plan could not know is `dynamic`, and takes any type. */
export function typeFits(planned: Type, actual: Type): boolean {
  if (planned.kind === 'dynamic') return true;
  if (planned.kind === 'object') return objectFits(planned, actual, typeFits);
  if (planned.kind === 'tuple') return tupleFits(planned, actual, typeFits);
  if (planned.kind !== actual.kind) return false;

  return !('element' in planned) || !('element' in actual) || typeFits(planned.element, actual.element);
}
