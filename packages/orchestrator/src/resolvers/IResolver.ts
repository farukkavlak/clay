import { IState } from '@clay/state';

import { Address } from '../Address';

export interface IResolver {
  resolve(pathParts: string[], context: Address, state: IState): unknown;
}
