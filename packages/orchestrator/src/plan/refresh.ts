import { Address, State } from '@clay/core';

import { inOrder, Limit } from '../providers/Limit';
import { ReadBack } from './imports';
import { Moves } from './moves';

function blockOf(key: string): string {
  const { module, resourceType, name } = Address.parse(key);
  return new Address(module.withoutKeys(), resourceType, name).toString();
}

/**
 * Reads each object the state holds back from its provider once: as the walk reaches its block, after everything the block waits for, and
 * the objects no block reaches once the walk is done.
 */
export class Refresh {
  /** By the resource block each object is of. */
  private pending = new Map<string, string[]>();
  /** By the address the state held each object at before the run; null where its provider no longer finds it. */
  private readonly found = new Map<string, Record<string, unknown> | null>();

  constructor(
    private readonly limit: Limit,
    private readonly moves: Moves,
    private readonly readBack: ReadBack
  ) {}

  /** After the moved blocks have moved the state, so each object is where the walk looks for it. */
  begin(state: State): void {
    this.pending = new Map();
    for (const key of Object.keys(state.resources)) {
      const block = blockOf(key);
      const keys = this.pending.get(block);
      if (keys) keys.push(key);
      else this.pending.set(block, [key]);
    }
  }

  /** Before any instance of the resource is planned, in every instance of its module. */
  async block(resource: Address, state: State): Promise<void> {
    const keys = this.pending.get(resource.toString()) ?? [];
    this.pending.delete(resource.toString());
    await this.read(state, keys);
  }

  async rest(state: State): Promise<void> {
    const keys = [...this.pending.values()].flat();
    this.pending.clear();
    await this.read(state, keys);
  }

  /** The objects at the addresses the state held them at, as read; one found gone is left out. */
  prior(prevRun: State): State {
    const resources: State['resources'] = {};
    for (const [key, resource] of Object.entries(prevRun.resources)) {
      const attributes = this.found.get(key);
      if (attributes) resources[key] = { ...resource, attributes };
    }

    return { ...prevRun, resources };
  }

  /** One found gone leaves the state, so the plan makes it again if the configuration still has it. */
  private async read(state: State, keys: string[]): Promise<void> {
    await inOrder(
      keys.map((key) =>
        this.limit.run(async () => {
          const origin = this.moves.originOf(key) ?? key;
          const attributes = await this.readBack(origin, state.resources[key]);
          this.found.set(origin, attributes);
          if (attributes === null) delete state.resources[key];
          else state.resources[key] = { ...state.resources[key], attributes };
        })
      )
    );
  }
}
