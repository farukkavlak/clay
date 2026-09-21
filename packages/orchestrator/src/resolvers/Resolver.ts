import { Address, State } from '@clay/contracts';

export interface Resolver {
  resolve(pathParts: string[], context: Address, state: State): unknown;
}
