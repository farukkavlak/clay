import { Graph } from '@clay/graph';
import { LocalProvider } from '@clay/provider-local';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createValidateCommand } from '../src/commands/validate';

vi.mock('node:fs/promises');
vi.mock('@clay/provider-local', () => {
  return {
    LocalProvider: vi.fn(),
  };
});

vi.mock('@clay/parser', async () => {
  const actual: any = await vi.importActual('@clay/parser');
  return {
    ...actual,
    Lexer: vi.fn().mockImplementation(function (code) {
      return new actual.Lexer(code);
    }),
    // Parser needs to be kept as is
  };
});

describe('Validate Command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let validateMock: ReturnType<typeof vi.fn>;
  let getSchemaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('ProcessExit');
    });
    vi.clearAllMocks();

    validateMock = vi.fn().mockResolvedValue(undefined);
    getSchemaMock = vi.fn().mockResolvedValue({ attributes: { path: { type: 'string' }, content: { type: 'string' } } });

    // Use function declaration to support 'new'
    vi.mocked(LocalProvider).mockImplementation(function () {
      return {
        validate: validateMock,
        getSchema: getSchemaMock,
      } as unknown as LocalProvider;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate correct config successfully', async () => {
    const validConfig = `
resource "local_file" "test" {
  path = "/tmp/test.txt"
  content = "Hello World"
}
`;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(validConfig);

    const command = createValidateCommand();
    await command.parseAsync(['node', 'test', '/tmp/test.clay']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Checking syntax'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Syntax is valid'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Validating resource schemas'));
    expect(validateMock).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Checking dependencies'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should detect syntax errors', async () => {
    const invalidConfig = `
resource "local_file" "test" {
  path = "/tmp/test.txt"
  content = 
}
`;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(invalidConfig);

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/test.clay']);
    } catch {
      // ignore
    }

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('Syntax error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should detect schema validation errors', async () => {
    // We don't care about config content for this specific test because we mock the provider error
    const config = `
resource "local_file" "test" {
  path = "/tmp/test.txt"
}
`;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(config);

    // Make validate throw
    validateMock.mockRejectedValue(new Error('local_file requires "content" attribute'));

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/test.clay']);
    } catch {
      // ignore
    }

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('Validating resource schemas');
    expect(validateMock).toHaveBeenCalled();
    // Should show error for missing 'content' attribute
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should detect circular dependencies', async () => {
    const circularConfig = `
resource "local_file" "a" {
  path = "/tmp/a.txt"
  content = "\${local_file.b.path}"
}

resource "local_file" "b" {
  path = "/tmp/b.txt"
  content = "\${local_file.a.path}"
}
`;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(circularConfig);

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/test.clay']);
    } catch {
      // ignore
    }

    // Circular dependency should be detected
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Checking dependencies'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency error'), expect.anything());
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle missing file', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/nonexistent.clay']);
    } catch (error: unknown) {
      expect((error as Error).message).toBe('ProcessExit');
    }

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should validate multiple resources', async () => {
    const multiResourceConfig = `
resource "local_file" "file1" {
  path = "/tmp/file1.txt"
  content = "Content 1"
}

resource "local_file" "file2" {
  path = "/tmp/file2.txt"
  content = "Content 2"
}
`;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(multiResourceConfig);

    const command = createValidateCommand();
    await command.parseAsync(['node', 'test', '/tmp/test.clay']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('local_file.file1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('local_file.file2'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });

  it('should handle dependency validation errors', async () => {
    // Spy on Graph.prototype.topologicalSort to throw
    const graphSpy = vi.spyOn(Graph.prototype, 'topologicalSort').mockImplementation(() => {
      throw new Error('Graph error');
    });

    const validConfig = 'resource "local_file" "test" {}';
    vi.mocked(fs.readFile).mockResolvedValue(validConfig);

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/test.clay']);
    } catch {
      // ignore
    }

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency error'), expect.anything());
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Graph error'));

    graphSpy.mockRestore();
  });

  it('should validation process errors', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('Access error'));

    const command = createValidateCommand();
    try {
      await command.parseAsync(['node', 'test', '/tmp/start_error.clay']);
    } catch {
      // ignore
    }

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle missing schema for resource', async () => {
    const config = `
resource "unknown_type" "test" {
  attr = "val"
}
`;
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(config);
    getSchemaMock.mockResolvedValue(undefined);

    const command = createValidateCommand();
    await command.parseAsync(['node', 'test', '/tmp/test.clay']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No schema found for unknown_type'));
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should skip validation for non-resource statements and empty attributes', async () => {
    const config = `
data "source" "test" {}
resource "local_file" "empty" {}
`;
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(config);
    // getSchemaMock returns valid schema by default

    const command = createValidateCommand();
    await command.parseAsync(['node', 'test', '/tmp/test.clay']);

    // Should skip 'data' block schema validation
    // Should skip 'empty' resource validation logic dependent on attributes if any?
    // Actually validateSchemas calls provider.validate even if attributes empty?
    // validate.ts:40 const attrs = {}; if (stmt.attributes) ...; await provider.validate(..., attrs);
    // So provider.validate IS called with empty object.

    // But checkCircularDependencies skips if !stmt.attributes
    // validate.ts:81 if (stmt.type !== 'Resource' || !stmt.attributes) continue;

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });

  it('should track dependencies from direct references', async () => {
    // Config with direct reference (not string interpolation)
    const config = `
resource "local_file" "dep" {
    path = "dep.txt"
}
resource "local_file" "main" {
    path = "main.txt"
    content = local_file.dep.path
}
`;
    // content = local_file.dep.path should be parsed as Reference type

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(config);

    const command = createValidateCommand();
    await command.parseAsync(['node', 'test', '/tmp/test.clay']);

    // Validates that dependency tracking logic runs without error
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });

  describe('Edge Cases & Error Handling', () => {
    it('should handle string errors in syntax validation', async () => {
      // Mock Lexer to throw a string
      const { Lexer } = await import('@clay/parser');
      vi.mocked(Lexer).mockImplementationOnce(function () {
        throw 'String Syntax Error';
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue('invalid');

      const command = createValidateCommand();
      try {
        await command.parseAsync(['node', 'test', '/tmp/test.clay']);
      } catch {
        /* ignore */
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Syntax error:'), 'String Syntax Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle string errors in schema validation', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

      validateMock.mockRejectedValue('String Schema Error');

      const command = createValidateCommand();
      try {
        await command.parseAsync(['node', 'test', '/tmp/test.clay']);
      } catch {
        /* ignore */
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('test.t:'), 'String Schema Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle string errors in dependency validation', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

      // Mock Graph to throw string
      const { Graph } = await import('@clay/graph');
      vi.spyOn(Graph.prototype, 'addNode').mockImplementationOnce(() => {
        throw 'String Dependency Error';
      });

      const command = createValidateCommand();
      try {
        await command.parseAsync(['node', 'test', '/tmp/test.clay']);
      } catch {
        /* ignore */
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency error:'), 'String Dependency Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle string errors in main action execution', async () => {
      // We fail readFile to trigger the main catch block
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockRejectedValue('String Read Error');

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const command = createValidateCommand();
      try {
        await command.parseAsync(['node', 'test', '/tmp/test.clay']);
      } catch {
        /* ignore */
      }

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Validation error:'), 'String Read Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);

      spy.mockRestore();
    });

    it('should ignore variable and data references in dependencies', async () => {
      // References like var.x or data.y should NOT create edges
      // Also invalid refs like single word
      const config = `
resource "test" "t" {
  attr_var = "\${var.my_var}"
  attr_data = "\${data.aws_ami.id}"
  attr_short = "\${simple_string}"
  ref_var = var.x
  ref_data = data.y.z
  ref_short = simple_ref
}
`;
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(config);

      // We spy on Graph.addEdge to ensure it is NOT called
      const { Graph } = await import('@clay/graph');
      const addEdgeSpy = vi.spyOn(Graph.prototype, 'addEdge');

      const command = createValidateCommand();
      await command.parseAsync(['node', 'test', '/tmp/test.clay']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
      // No edges should be added because references are ignored types or invalid length
      expect(addEdgeSpy).not.toHaveBeenCalled();
    });
  });
});
