import { Address, ModuleAddress, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { DataBlock, spell } from '@clay/parser';

import { DependencyGraphBuilder, GraphNode } from '../graph/DependencyGraphBuilder';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { DataInstance, enclosing, sharedModule } from '../keys';
import { tryAt } from '../place';
import { inOrder } from '../providers/Limit';
import { Planned } from '../values/Planned';
import { Value } from '../values/Value';
import { DataSourceReader } from './DataSourceReader';
import { PlanReader, Walk } from './PlanReader';

/** What a data source instance read, or nothing where it waits for the apply. */
export interface DataRead {
  at: DataInstance;
  read?: Record<string, Value>;
}

/** Reads each data source at plan, or leaves it to the apply where what it reads changes. */
export class DataPlanner {
  constructor(
    private graphBuilder: DependencyGraphBuilder,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned,
    private reader: DataSourceReader,
    private reads: PlanReader
  ) {}

  /** Each module instance reads its own, and waits for the apply on its own. A check reads none. */
  async plan(key: string, { module, block }: Extract<GraphNode, { kind: 'data' }>, graph: Graph<GraphNode>, state: State, walk: Walk): Promise<DataRead[]> {
    const blocks = this.graphBuilder.resourceDependencies(graph, key);
    const reads = await inOrder(this.modules.of(module).map((instance) => this.readIn(block, blocks, instance, state, walk)));

    return reads.flat();
  }

  private async readIn(block: DataBlock, blocks: string[], instance: ModuleAddress, state: State, walk: Walk): Promise<DataRead[]> {
    const waits = walk === 'check' || this.waitsForApply(blocks, instance);

    return inOrder(this.dataInstances(block, instance, state, walk).map((at) => this.readData(block, at, state, waits)));
  }

  private async readData(block: DataBlock, at: DataInstance, state: State, waits: boolean): Promise<DataRead> {
    const inputs = this.resolveInputs(block, state, at);
    if (!waits) return { at, read: await this.reader.read(block, inputs, at) };

    await this.reader.defer(block, inputs, at);
    return { at };
  }

  /** Its count or for_each is read in its module instance before any instance exists. */
  private dataInstances(block: DataBlock, module: ModuleAddress, state: State, walk: Walk): DataInstance[] {
    const at = new DataInstance(module, block.dataSourceType, block.name);
    if (!block.count && !block.forEach) return [at];

    this.reads.setKeys(walk, at.block, block, at, state);
    return at.instances(this.instances.keysOf(at.block) ?? []);
  }

  /**
   * Read now, it would see the world before the apply changes a resource it reads, even through a variable, a local or an output.
   * A value not known yet comes only from such a change, so its inputs are known whenever it is read now.
   */
  private waitsForApply(blocks: string[], module: ModuleAddress): boolean {
    return this.instancesOf(blocks, module).some((instance) => this.planned.get(instance)?.changes === true);
  }

  /** One value at a time, so an error points at the value, not the block. */
  private resolveInputs(block: DataBlock, state: State, at: DataInstance): Record<string, Value> {
    const declaration = spell(block);

    return Object.fromEntries(
      Object.entries(block.attributes).map(([name, value]) => [name, tryAt(value.position, declaration, at, () => this.reads.resolveOrUnknown(value, state, at))])
    );
  }

  /** Only instances in the reader's own module instance: `module.a[0]` reads from `module.a[0]`, never `module.a[1]`. */
  private instancesOf(blocks: string[], reader: ModuleAddress): string[] {
    return blocks.flatMap((block) => {
      const { module, resourceType, name } = Address.parse(block);
      const shared = sharedModule(module, reader.withoutKeys());
      const readerIn = enclosing(reader, shared).toString();

      return this.modules
        .of(module)
        .filter((instance) => enclosing(instance, shared).toString() === readerIn)
        .flatMap((instance) => this.instancesIn(new Address(instance, resourceType, name)));
    });
  }

  private instancesIn(block: Address): string[] {
    const keys = this.instances.keysOf(block.toString());
    if (keys === undefined) return [block.toString()];

    return keys.map((key) => new Address(block.module, block.resourceType, block.name, key).toString());
  }
}
