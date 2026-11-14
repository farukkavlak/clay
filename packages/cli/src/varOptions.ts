import { envInputs } from '@clay/orchestrator';
import { NamedInput, VariableInput } from '@clay/planner';
import { InvalidArgumentError, Option } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Read from the root module's directory, when there is one, before any value from the command line. */
const AUTO_FILE = 'clay.clayvars';

/** The value may hold `=` too; only the first one ends the name. */
function parseVar(pair: string): NamedInput {
  const equals = pair.indexOf('=');
  if (equals <= 0) throw new InvalidArgumentError('it takes name=value');

  return { from: 'var', name: pair.slice(0, equals), text: pair.slice(equals + 1) };
}

/** A file named on the command line, read once the command runs, so an error reading it is reported as the command's. */
interface NamedFile {
  from: 'file';
  file: string;
}

type Given = NamedInput | NamedFile;

async function readVarFile(cwd: string, { file }: NamedFile): Promise<VariableInput> {
  try {
    return { from: 'file', file, text: await fs.readFile(path.resolve(cwd, file), 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    throw new Error(`${file} not found`, { cause: error });
  }
}

/** Both flags fill one list, so a later value wins whichever flag gave it. */
export function varOptions(): Option[] {
  const given: Given[] = [];
  const add = (input: Given) => {
    given.push(input);
    return given;
  };

  return [
    new Option('--var <name=value>', 'Give a root variable a value; a later one for the same name wins').argParser((pair) => add(parseVar(pair))),
    new Option('--var-file <file>', 'Give root variables the values a file holds, as name = value lines').argParser((file) => add({ from: 'file', file })),
  ];
}

export interface VarFlags {
  var?: Given[];
  varFile?: Given[];
}

/** The flag a saved plan refuses, since it keeps the values it was made with. */
export function varFlagOf(flags: VarFlags): string | undefined {
  if (flags.var !== undefined) return '--var';
  return flags.varFile === undefined ? undefined : '--var-file';
}

async function autoFile(cwd: string): Promise<VariableInput[]> {
  try {
    return [{ from: 'file', file: AUTO_FILE, text: await fs.readFile(path.join(cwd, AUTO_FILE), 'utf8') }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    return [];
  }
}

/** The environment comes first, then `clay.clayvars`, then the flags in the order given, so a later value wins. */
export async function givenInputs(cwd: string, flags: VarFlags): Promise<VariableInput[]> {
  const flagged = await Promise.all((flags.var ?? flags.varFile ?? []).map((given) => (given.from === 'file' ? readVarFile(cwd, given) : given)));
  return [...envInputs(process.env), ...(await autoFile(cwd)), ...flagged];
}
