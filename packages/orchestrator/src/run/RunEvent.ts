import { Output } from '@clay/contracts';
import { PlanAction } from '@clay/planner';

/**
 * State is on disk by the time `applied`, `destroyed` or `failed` arrives, unless the `failed` after it carries a `stateError`. `unsaved`
 * comes from a run that stopped and could not write the state whole, which its journal still holds.
 */
export type RunEvent =
  | { type: 'planned'; actions: PlanAction[] }
  | { type: 'started'; action: PlanAction }
  | { type: 'applied'; action: PlanAction }
  /** A replace's object destroyed apart from its new one: before its turn, or before a create that failed. */
  | { type: 'destroyed'; action: PlanAction }
  | { type: 'read'; address: string }
  | { type: 'failed'; action: PlanAction; error: Error; stateError?: Error }
  | { type: 'unsaved'; error: Error }
  | { type: 'done'; outputs: Record<string, Output> };
