import { Address, Resource } from '@clay/contracts';
import { spell } from '@clay/parser';
import { PlanAction } from '@clay/planner';

import { ConfiguredResource } from './components/DesiredStateBuilder';
import { withPlace } from './place';

/** A replace goes by the block, which is still written; a delete by the state, since the block may be gone or not name that instance. */
export function checkPreventDestroy(actions: PlanAction[], desired: ConfiguredResource[], resources: Record<string, Resource>): void {
  const blocks = new Map(desired.map((resource) => [resource.address.toString(), resource]));

  for (const action of actions) {
    const address = Address.of(action).toString();
    const found = blocks.get(address);

    if (action.type === 'REPLACE' && found?.preventDestroy === true) {
      const refusal = new Error(`${address} cannot be replaced: it has prevent_destroy = true. Set it to false and apply first.`);
      throw withPlace(refusal, found.block.position, spell(found.block), found.address.module);
    }

    if (action.type === 'DELETE' && !action.deposed && resources[address]?.preventDestroy === true)
      throw new Error(`${address} cannot be deleted: it was applied with prevent_destroy = true. To delete it, set prevent_destroy = false, apply, then delete it.`);
  }
}
