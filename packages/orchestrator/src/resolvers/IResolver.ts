import { Address, IState } from '@clay/contracts';

export interface IResolver {
  resolve(pathParts: string[], context: Address, state: IState): unknown;
}
