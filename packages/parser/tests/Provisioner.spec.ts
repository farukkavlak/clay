import { describe, expect, it } from 'vitest';

import { ConfigError, Parser, ResourceBlock } from '../src';
import { Lexer } from '../src/Lexer';

const parse = (source: string) => new Parser(new Lexer(source, 'main.clay').tokenize()).parse();
const resource = (source: string) => parse(source)[0] as ResourceBlock;

const errorOf = (source: string): ConfigError => {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

describe('Parser - provisioner block', () => {
  it('reads its type and its arguments apart from the attributes', () => {
    const block = resource('resource "t" "a" {\n  path = "a"\n  provisioner "local-exec" {\n    command = "echo"\n  }\n}');

    expect(block.provisioners).toMatchObject([
      { provisionerType: { value: 'local-exec', position: { line: 3, column: 15 } }, attributes: { command: { type: 'String', value: 'echo' } }, position: { line: 3, column: 3 } },
    ]);
    expect(Object.keys(block.attributes)).toEqual(['path']);
  });

  it('keeps several in the order written, beside a lifecycle block on either side', () => {
    const block = resource('resource "t" "a" { provisioner "one" {} lifecycle { prevent_destroy = true } provisioner "two" {} }');

    expect(block.provisioners?.map(({ provisionerType }) => provisionerType.value)).toEqual(['one', 'two']);
    expect(block.lifecycle).toMatchObject({ preventDestroy: true });
  });

  it.each(['continue', 'fail'])('reads on_failure = %s apart from the arguments', (word) => {
    const [provisioner] = resource(`resource "t" "a" {\n  provisioner "x" {\n    on_failure = ${word}\n    command    = "echo"\n  }\n}`).provisioners!;

    expect(provisioner.onFailure).toBe(word);
    expect(Object.keys(provisioner.attributes)).toEqual(['command']);
  });

  it('leaves on_failure out of a provisioner that does not set it', () => {
    expect(resource('resource "t" "a" { provisioner "x" {} }').provisioners![0]).not.toHaveProperty('onFailure');
  });

  it.each(['create', 'destroy'])('reads when = %s apart from the arguments', (word) => {
    const [provisioner] = resource(`resource "t" "a" {\n  provisioner "x" {\n    when    = ${word}\n    command = "echo"\n  }\n}`).provisioners!;

    expect(provisioner.when).toBe(word);
    expect(Object.keys(provisioner.attributes)).toEqual(['command']);
  });

  it('leaves when out of a provisioner that does not set it', () => {
    expect(resource('resource "t" "a" { provisioner "x" {} }').provisioners![0]).not.toHaveProperty('when');
  });

  it('is left out of a resource without one', () => {
    expect(resource('resource "t" "a" {}')).not.toHaveProperty('provisioners');
  });

  it.each([
    ['a provisioner with no type', 'resource "t" "a" {\n  provisioner {}\n}', "Expect provisioner type string after 'provisioner'.", 2, 15],
    ['a provisioner with two labels', 'resource "t" "a" {\n  provisioner "x" "y" {}\n}', "Expect '{' after provisioner type.", 2, 19],
    ['a block inside a provisioner', 'resource "t" "a" {\n  provisioner "x" {\n    connection {}\n  }\n}', "Expect '=' after attribute name.", 3, 16],
    ['an argument set twice', 'resource "t" "a" {\n  provisioner "x" {\n    command = "a"\n    command = "b"\n  }\n}', 'command is set twice', 4, 5],
    ['on_failure in quotes', 'resource "t" "a" {\n  provisioner "x" {\n    on_failure = "continue"\n  }\n}', 'on_failure is continue or fail, written without quotes.', 3, 18],
    ['on_failure as another word', 'resource "t" "a" {\n  provisioner "x" {\n    on_failure = ignore\n  }\n}', 'on_failure is continue or fail.', 3, 18],
    ['on_failure as a reference', 'resource "t" "a" {\n  provisioner "x" {\n    on_failure = var.mode\n  }\n}', 'on_failure is continue or fail.', 3, 18],
    ['when in quotes', 'resource "t" "a" {\n  provisioner "x" {\n    when = "destroy"\n  }\n}', 'when is create or destroy, written without quotes.', 3, 12],
    ['when as another word', 'resource "t" "a" {\n  provisioner "x" {\n    when = later\n  }\n}', 'when is create or destroy.', 3, 12],
    ['a wrong when, before a block later in it', 'resource "t" "a" {\n  provisioner "x" {\n    when = later\n    connection {}\n  }\n}', 'when is create or destroy.', 3, 12],
    ['when as a reference', 'resource "t" "a" {\n  provisioner "x" {\n    when = var.when\n  }\n}', 'when is create or destroy.', 3, 12],
    ['on_failure with a step below the word', 'resource "t" "a" {\n  provisioner "x" {\n    on_failure = continue.now\n  }\n}', 'on_failure is continue or fail.', 3, 18],
    [
      'a wrong on_failure, before a block later in it',
      'resource "t" "a" {\n  provisioner "x" {\n    on_failure = ignore\n    connection {}\n  }\n}',
      'on_failure is continue or fail.',
      3,
      18,
    ],
    ['a second lifecycle after a provisioner', 'resource "t" "a" {\n  provisioner "x" {}\n  lifecycle {}\n  lifecycle {}\n}', 'resource "t" "a" has two lifecycle blocks', 4, 3],
  ])('refuses %s', (_, source, message, line, column) => {
    const error = errorOf(source);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line, column });
  });

  it('is refused in a data source, where its = was looked for', () => {
    const error = errorOf('data "local_file" "a" {\n  provisioner "x" {}\n}');

    expect(error.message).toBe("Expect '=' after attribute name.");
    expect(error.position).toMatchObject({ line: 2, column: 15 });
  });
});
