import js from '@eslint/js';
import type { Linter } from 'eslint';
// @ts-expect-error -- the package ships no types
import eslintConfigPrettier from 'eslint-config-prettier';
// @ts-expect-error -- the package ships no types
import promise from 'eslint-plugin-promise';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import tseslint from 'typescript-eslint';

/** The orchestrator's folders, lowest first: each imports only from those before it, so a layer never reaches up. */
const FOLDERS = ['values', 'config', 'instances', 'providers', 'expressions', 'graph', 'plan', 'checks', 'run'];
const ORCHESTRATOR = 'packages/orchestrator/src';

function importsOnly(files: string[], forbidden: string[]): Linter.Config {
  const message = 'An orchestrator folder imports only from the folders above it in the README.';
  return { files, rules: { 'no-restricted-imports': ['error', { patterns: [{ group: forbidden.map((folder) => `**/${folder}/*`), message }] }] } };
}

/** The files beside the folders are shared by all, so they import none; `Orchestrator.ts` holds the engine, which needs them all. */
const folderOrder: Linter.Config[] = [
  ...FOLDERS.slice(0, -1).map((folder, index) => importsOnly([`${ORCHESTRATOR}/${folder}/**/*.ts`], FOLDERS.slice(index + 1))),
  { ...importsOnly([`${ORCHESTRATOR}/*.ts`], FOLDERS), ignores: [`${ORCHESTRATOR}/index.ts`, `${ORCHESTRATOR}/Orchestrator.ts`] },
];

/** npm links every workspace into node_modules, so TypeScript finds a package its package.json leaves out. */
function listedOnly(dir: string): Linter.Config {
  type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(path.join(__dirname, dir, 'package.json'), 'utf8')) as Manifest;
  const listed = Object.keys({ ...dependencies, ...devDependencies }).filter((name) => name.startsWith('@clay/'));
  const message = 'A package imports only the @clay packages its package.json lists.';
  // A rule of its own, as the folder order already sets no-restricted-imports in the orchestrator.
  const rule: Linter.RuleEntry = ['error', { patterns: [{ group: ['@clay/*', ...listed.map((name) => `!${name}`)], message }] }];
  const unlisted = (source: string) =>
    `[${source}=/^@clay./]` + (listed.length > 0 ? `:not([${source}=/^@clay.(${listed.map((name) => name.replace('@clay/', '')).join('|')})$/])` : '');
  // `await import(...)` and `typeof import(...)` are not import declarations, so the rule above passes them.
  const dynamic: Linter.RuleEntry = [
    'error',
    { selector: `ImportExpression${unlisted('source.value')}`, message },
    { selector: `TSImportType${unlisted('argument.literal.value')}`, message },
  ];

  return { files: [`${dir}/**/*.ts`], rules: { '@typescript-eslint/no-restricted-imports': rule, 'no-restricted-syntax': dynamic } };
}

const PACKAGES = ['packages', 'providers'].flatMap((root) =>
  readdirSync(path.join(__dirname, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${root}/${entry.name}`)
);

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  promise.configs['flat/recommended'],
  unicorn.configs['flat/recommended'],
  {
    files: ['**/*.{js,mjs,cjs,ts,mts}'],
    languageOptions: { globals: globals.node },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      eqeqeq: 'error',
      'array-callback-return': 'error',
      'no-self-compare': 'error',
      'no-useless-assignment': 'error',
      'no-promise-executor-return': 'error',
      'no-unreachable-loop': 'error',
      'promise/no-multiple-resolved': 'error',
      'no-use-before-define': 'error',
      'consistent-return': 'error',
      'require-atomic-updates': 'error',
      // Config attribute and resource names are snake_case, and tests spell them as keys.
      camelcase: ['error', { properties: 'never' }],
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],

      'unicorn/filename-case': ['error', { cases: { camelCase: true, pascalCase: true } }],
      // Names like dir, err and pkg read fine; JSON has null; a CLI exits; reduce sums a list.
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/no-array-reduce': 'off',
      // The packages and their tests compile to CommonJS, which has no import.meta.
      'unicorn/prefer-module': 'off',
      // A mock that takes one argument is given undefined on purpose.
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
    },
  },
  ...folderOrder,
  ...PACKAGES.map((dir) => listedOnly(dir)),
  {
    // Tests are tables of cases and grow with what they cover.
    files: ['packages/*/src/**/*.ts', 'providers/*/src/**/*.ts'],
    rules: { 'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }] },
  },
  eslintConfigPrettier,
  // Prettier's config turns curly off as a formatting rule, so it is set after it.
  { rules: { curly: ['error', 'multi'] } },
] satisfies Linter.Config[];
