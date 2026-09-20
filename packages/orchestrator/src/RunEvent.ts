import { PlanAction } from '@clay/planner';

/** What an apply reports as it goes. State is on disk by the time `applied` or `failed` arrives, unless `failed` carries a `stateError`. */
export type RunEvent =
  | { type: 'planned'; actions: PlanAction[] }
  | { type: 'started'; action: PlanAction }
  | { type: 'applied'; action: PlanAction }
  | { type: 'failed'; action: PlanAction; error: Error; stateError?: Error }
  | { type: 'done'; outputs: Record<string, unknown> };
