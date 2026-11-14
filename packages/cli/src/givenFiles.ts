import { ConfigFiles, givenAt } from '@clay/orchestrator';
import { VariableInput } from '@clay/planner';

/** Reads a `--var` value as the file an error in it names; the last one for a name wins, as in the run. */
export function givenFiles(files: ConfigFiles, variables: readonly VariableInput[] = []): ConfigFiles {
  const given = new Map(variables.map(({ name, text }) => [givenAt(name), text]));

  return {
    read: (file) => given.get(file) ?? files.read(file),
    list: (dir) => files.list(dir),
  };
}
