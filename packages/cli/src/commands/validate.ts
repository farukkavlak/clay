import { Graph } from '@clay/graph';
import { CONFIG_FILE, Lexer, Parser, Program } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function validateSyntax(configContent: string): Promise<Program> {
  console.log(chalk.cyan('→ Checking syntax...'));
  try {
    const lexer = new Lexer(configContent);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const program = parser.parse();
    console.log(chalk.green('  ✓ Syntax is valid'));
    return program;
  } catch (error) {
    console.log(chalk.red('  ✗ Syntax error:'), error instanceof Error ? error.message : error);
    process.exit(1);
    throw error;
  }
}

async function validateSchemas(program: Program): Promise<void> {
  console.log(chalk.cyan('→ Validating resource schemas...'));
  const provider = new LocalProvider();
  let schemaErrors = 0;

  for (const stmt of program) {
    if (stmt.type !== 'Resource') continue;

    try {
      const schema = await provider.getSchema(stmt.resourceType);
      if (!schema) {
        console.log(chalk.yellow(`  ⚠ No schema found for ${stmt.resourceType}`));
        continue;
      }

      const attrs: Record<string, unknown> = {};
      if (stmt.attributes) for (const [key, value] of Object.entries(stmt.attributes)) attrs[key] = (value as { type: string; value: unknown }).value;

      await provider.validate(stmt.resourceType, attrs);
      console.log(chalk.green(`  ✓ ${stmt.resourceType}.${stmt.name}`));
    } catch (error) {
      console.log(chalk.red(`  ✗ ${stmt.resourceType}.${stmt.name}:`), error instanceof Error ? error.message : error);
      schemaErrors++;
    }
  }

  if (schemaErrors > 0) {
    console.log(chalk.red(`\n✗ Validation failed with ${schemaErrors} error(s)`));
    process.exit(1);
  }
}

function checkStringDependencies(value: string, key: string, graph: Graph<null>): void {
  const matches = value.matchAll(/\${([^}]+)}/g);
  for (const match of matches) {
    const expr = match[1];
    const refParts = expr.trim().split('.');
    if (refParts.length >= 2 && refParts[0] !== 'var' && refParts[0] !== 'data') {
      const depKey = `${refParts[0]}.${refParts[1]}`;
      if (graph.hasNode(depKey)) graph.addEdge(depKey, key);
    }
  }
}

function checkAttributeDependencies(attrName: string, attrValue: { type: string; value: unknown }, key: string, graph: Graph<null>): void {
  if (attrValue.type === 'Reference') {
    const refParts = attrValue.value as string[];
    if (refParts.length >= 2 && refParts[0] !== 'var' && refParts[0] !== 'data') {
      const depKey = `${refParts[0]}.${refParts[1]}`;
      if (graph.hasNode(depKey)) graph.addEdge(depKey, key);
    }
  } else if (attrValue.type === 'String' && typeof attrValue.value === 'string') checkStringDependencies(attrValue.value, key, graph);
}

function checkCircularDependencies(program: Program, graph: Graph<null>): void {
  for (const stmt of program) {
    if (stmt.type !== 'Resource' || !stmt.attributes) continue;

    const key = `${stmt.resourceType}.${stmt.name}`;

    for (const [name, attr] of Object.entries(stmt.attributes)) checkAttributeDependencies(name, attr as { type: string; value: unknown }, key, graph);
  }
}

function validateDependencies(program: Program): void {
  console.log(chalk.cyan('→ Checking dependencies...'));
  try {
    const graph = new Graph<null>();

    for (const stmt of program)
      if (stmt.type === 'Resource') {
        const key = `${stmt.resourceType}.${stmt.name}`;
        graph.addNode(key, null);
      }

    checkCircularDependencies(program, graph);

    graph.topologicalSort();
    console.log(chalk.green('  ✓ No circular dependencies'));
  } catch (error) {
    console.log(chalk.red('  ✗ Dependency error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate configuration files')
    .argument('[config]', 'Path to config file', CONFIG_FILE)
    .action(async (configPath: string) => {
      try {
        const fullPath = path.resolve(process.cwd(), configPath);
        console.log(chalk.bold(`\nValidating ${configPath}...\n`));

        try {
          await fs.access(fullPath);
        } catch {
          console.log(chalk.red('✗ File not found'));
          process.exit(1);
        }

        const configContent = await fs.readFile(fullPath, 'utf8');
        const program = await validateSyntax(configContent);

        await validateSchemas(program);
        validateDependencies(program);

        console.log(chalk.bold.green('\n✓ Configuration is valid\n'));
      } catch (error) {
        console.error(chalk.red('Validation error:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  return command;
}
