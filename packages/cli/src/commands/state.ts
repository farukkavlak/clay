import { Address, inAddressOrder, Marks, Resource, State } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { forgetDependencies, moveResource, StateBackend, StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { interruptible } from '../interruptible';
import { attributeName, printable } from '../printable';
import { show } from '../showPlan';
import { stateFile } from '../stateFile';

/** A resource's attributes as `state show` prints them, a sensitive part hidden. */
function printAttributes(resourceType: string, name: string, attributes: Record<string, unknown>, sensitive: Resource['sensitive']): void {
  console.log(`resource "${resourceType}" "${name}" {`);
  const marks = Marks.of(sensitive ?? []);
  for (const [key, value] of Object.entries(attributes)) console.log(`  ${attributeName(key)} = ${show(value, marks.under(key))}`);

  console.log('}');
}

/** What a replace left behind goes with the resource, and nothing is left to destroy it. */
function forgetDeposed(state: State, key: string): void {
  if (!state.deposed) return;

  delete state.deposed[key];
  if (Object.keys(state.deposed).length === 0) delete state.deposed;
}

const configHere = () => new RecordingFiles(new DiskFiles(process.cwd()));

function getStateManager(files: RecordingFiles): StateManager {
  return new StateManager(stateFile(process.cwd(), files));
}

async function reportEmpty(backend: StateBackend): Promise<void> {
  const start = (await backend.exists()) ? 'No resources in' : 'No state file found at';

  console.log(styleText('yellow', printable(`${start} ${backend.location}`)));
}

/** Own keys only, so `toString` is not a resource. */
function findResource(state: State, address: string): Resource | undefined {
  const key = Address.parse(address).toString();

  return Object.hasOwn(state.resources, key) ? state.resources[key] : undefined;
}

/** A move may not change the type, which decides the provider. */
function checkedMove(state: State, source: string, destination: string): void {
  const from = Address.parse(source);
  const to = Address.parse(destination);
  if (from.resourceType !== to.resourceType) throw new Error(`Cannot move ${source} to ${destination}: the type changes`);

  moveResource(state, from, to);
}

export function createStateCommand(): Command {
  const command = new Command('state').description('Advanced state management');

  command
    .command('list')
    .description('List resources in the state')
    .action(async () => {
      const files = configHere();
      try {
        const backend = stateFile(process.cwd(), files);
        const state = await new StateManager(backend).read();

        const deposed = inAddressOrder(state.deposed ?? {});
        if (Object.keys(state.resources).length === 0 && deposed.length === 0) {
          await reportEmpty(backend);
          return;
        }

        for (const [key] of inAddressOrder(state.resources)) console.log(key);
        for (const [key] of deposed) console.log(`${key} (deposed)`);
      } catch (error) {
        console.error(styleText('red', 'Error listing state:'), describeError(error, files));
        process.exit(1);
      }
    });

  command
    .command('show')
    .description('Show a resource in the state')
    .argument('<address>', 'Resource address')
    .action(async (address) => {
      const files = configHere();
      try {
        const manager = getStateManager(files);
        const state = await manager.read();
        const resource = findResource(state, address);
        const parsed = Address.parse(address);
        const deposed = state.deposed && Object.hasOwn(state.deposed, parsed.toString()) ? state.deposed[parsed.toString()] : [];

        if (!resource && deposed.length === 0) {
          console.error(styleText('red', `Resource not found: ${printable(address)}`));
          process.exit(1);
        }

        if (resource) {
          console.log(styleText('bold', `# ${address}${resource.tainted ? ' (tainted)' : ''}:`));
          printAttributes(resource.resourceType, resource.name, resource.attributes || {}, resource.sensitive);
        }

        for (const object of deposed) {
          console.log(styleText('bold', `# ${address} deposed:`));
          printAttributes(parsed.resourceType, parsed.name, object.attributes, object.sensitive);
        }
      } catch (error) {
        console.error(styleText('red', 'Error showing resource:'), describeError(error, files));
        process.exit(1);
      }
    });

  command
    .command('mv')
    .description('Move an item in the state')
    .argument('<source>', 'Source address')
    .argument('<destination>', 'Destination address')
    .action(async (source, destination) => {
      const files = configHere();
      try {
        const manager = getStateManager(files);
        await interruptible(async () => {
          await manager.lock('state mv');
          try {
            const state = await manager.read();

            if (!findResource(state, source)) throw new Error(`Source resource not found: ${source}`);

            if (findResource(state, destination)) throw new Error(`Destination resource already exists: ${destination}`);

            console.log(styleText('yellow', `Moving ${source} to ${destination}...`));

            checkedMove(state, source, destination);

            await manager.write(state);
            console.log(styleText('green', 'Successfully moved resource.'));
          } catch (error) {
            await manager.unlockAfter(error);
          } finally {
            await manager.unlock();
          }
        });
      } catch (error) {
        console.error(styleText('red', 'Error moving resource:'), describeError(error, files));
        process.exit(1);
      }
    });

  command
    .command('rm')
    .description('Remove instances from the state')
    .argument('<address>', 'Resource address')
    .action(async (address) => {
      const files = configHere();
      try {
        const manager = getStateManager(files);
        await interruptible(async () => {
          await manager.lock('state rm');
          try {
            const state = await manager.read();
            const key = Address.parse(address).toString();

            if (!Object.hasOwn(state.resources, key) && !(state.deposed && Object.hasOwn(state.deposed, key))) throw new Error(`Resource not found in state: ${address}`);

            console.log(styleText('yellow', `Removing ${key}...`));
            delete state.resources[key];
            forgetDeposed(state, key);
            forgetDependencies(state, [Address.parse(key)]);

            await manager.write(state);
            console.log(styleText('green', 'Successfully removed resource.'));
          } catch (error) {
            await manager.unlockAfter(error);
          } finally {
            await manager.unlock();
          }
        });
      } catch (error) {
        console.error(styleText('red', 'Error removing resource:'), describeError(error, files));
        process.exit(1);
      }
    });

  return command;
}
