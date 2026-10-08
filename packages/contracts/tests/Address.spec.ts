import { describe, expect, it } from 'vitest';

import { Address, isModulePath, ModuleAddress, parseDataAddress } from '../src/index';

describe('Address', () => {
  describe('toString', () => {
    it('should format root resource correctly', () => {
      const addr = Address.root('aws_instance', 'web');
      expect(addr.toString()).toBe('aws_instance.web');
    });

    it('should format module resource correctly', () => {
      const addr = new Address(ModuleAddress.root.child('vpc'), 'aws_subnet', 'main');
      expect(addr.toString()).toBe('module.vpc.aws_subnet.main');
    });

    it('should format nested module resource correctly', () => {
      const addr = new Address(ModuleAddress.root.child('core').child('net'), 'aws_vpc', 'main');
      expect(addr.toString()).toBe('module.core.module.net.aws_vpc.main');
    });

    it.each([
      ['a number', 0, 'local_file.a[0]'],
      ['a string', 'blog', 'local_file.a["blog"]'],
      ['a string with a dot in it', 'x.y', 'local_file.a["x.y"]'],
      ['a string with a quote and a backslash in it, escaped', 'say "hi" \\', String.raw`local_file.a["say \"hi\" \\"]`],
    ])('writes an instance key that is %s after the name', (_, key, written) => {
      expect(new Address(ModuleAddress.root, 'local_file', 'a', key).toString()).toBe(written);
    });

    it('writes an instance key of a resource in a module', () => {
      expect(new Address(ModuleAddress.root.child('app'), 'local_file', 'a', 1).toString()).toBe('module.app.local_file.a[1]');
    });
  });

  describe('parse', () => {
    it('should parse root resource string', () => {
      const addr = Address.parse('aws_instance.web');
      expect(addr.module).toEqual(ModuleAddress.root);
      expect(addr.resourceType).toBe('aws_instance');
      expect(addr.name).toBe('web');
    });

    it('should parse module resource string', () => {
      const addr = Address.parse('module.vpc.aws_subnet.private');
      expect(addr.module).toEqual(ModuleAddress.root.child('vpc'));
      expect(addr.resourceType).toBe('aws_subnet');
      expect(addr.name).toBe('private');
    });

    it('should parse nested module string', () => {
      const addr = Address.parse('module.app.module.db.aws_db_instance.main');
      expect(addr.module).toEqual(ModuleAddress.root.child('app').child('db'));
      expect(addr.resourceType).toBe('aws_db_instance');
      expect(addr.name).toBe('main');
    });

    it.each([
      ['local_file.a[0]', 0],
      ['local_file.a[9007199254740991]', 9_007_199_254_740_991],
      ['local_file.a["blog"]', 'blog'],
      ['local_file.a["x.y"]', 'x.y'],
      ['local_file.a["a[0]"]', 'a[0]'],
      [String.raw`local_file.a["say \"hi\""]`, 'say "hi"'],
      ['local_file.a[""]', ''],
    ])('reads the instance key of %s', (input, key) => {
      expect(Address.parse(input)).toEqual(new Address(ModuleAddress.root, 'local_file', 'a', key));
    });

    it('reads the instance key of a resource in a module', () => {
      expect(Address.parse('module.app.local_file.a[1]')).toEqual(new Address(ModuleAddress.root.child('app'), 'local_file', 'a', 1));
    });

    it.each([
      ['module.app[0].local_file.a', ModuleAddress.root.child('app', 0)],
      ['module.app["x.y"].module.db.local_file.a', ModuleAddress.root.child('app', 'x.y').child('db')],
      ['module.app["a]"].local_file.a', ModuleAddress.root.child('app', 'a]')],
      [String.raw`module.app["say \"hi\""].local_file.a`, ModuleAddress.root.child('app', 'say "hi"')],
      [String.raw`module.app["a\"]"].local_file.a`, ModuleAddress.root.child('app', 'a"]')],
    ])('reads the instance key of each module in %s', (input, module) => {
      expect(Address.parse(input)).toEqual(new Address(module, 'local_file', 'a'));
    });

    it.each(['local_file.a', 'module.app.local_file.a[3]', 'module.app["x"].module.db[0].local_file.a["y"]', 'local_file.a["x.y"]', String.raw`local_file.a["say \"hi\" \\"]`])(
      'reads back what it writes: %s',
      (input) => {
        expect(Address.parse(input).toString()).toBe(input);
      }
    );

    it.each([
      ['local_file.a[', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[-1]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[01]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[1.5]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[blog]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a["blog]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a["a"]["b"]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[9007199254740992]', 'a key is at most 9007199254740991'],
      ['local_file.a["a" ]', 'a key is written as ["a"]'],
      [String.raw`local_file.a["\u0062"]`, 'a key is written as ["b"]'],
      ['module.app["a"]["b"].local_file.a', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['module.app["x].local_file.a', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['module.app[01].local_file.a', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['module.app["a" ].local_file.a', 'a key is written as ["a"]'],
      ['local_file[0].a', 'a key comes after the name'],
      ['module[0].local_file.a', 'a key comes after the name'],
    ])('refuses the key in %s and says what is wrong', (input, reason) => {
      expect(() => Address.parse(input)).toThrow(`Invalid address "${input}": ${reason}`);
    });

    it.each([
      ['invalid', 'Invalid address "invalid": an address ends with a type and a name'],
      ['module.vpc', 'Invalid address "module.vpc": an address ends with a type and a name'],
      ['module.vpc[0]', 'Invalid address "module.vpc[0]": an address ends with a type and a name'],
      ['local_file.a[0].b', 'Invalid address "local_file.a[0].b": nothing may follow the name "a"'],
      ['module', 'Invalid address "module": a module needs a name after "module"'],
      ['local_file.a.b', 'Invalid address "local_file.a.b": nothing may follow the name "a"'],
      ['module.vpc.local_file.a.b', 'Invalid address "module.vpc.local_file.a.b": nothing may follow the name "a"'],
      ['local_file.', 'Invalid address "local_file.": a part of it is empty'],
      ['.a', 'Invalid address ".a": a part of it is empty'],
      ['module..local_file.a', 'Invalid address "module..local_file.a": a part of it is empty'],
      ['', 'Invalid address "": a part of it is empty'],
    ])('refuses %s and says what is wrong', (input, message) => {
      expect(() => Address.parse(input)).toThrow(message);
    });
  });

  describe('countCounterparts', () => {
    it.each([
      ['a resource with no key', 'local_file.a', ['local_file.a[0]']],
      ['the first instance of a resource', 'local_file.a[0]', ['local_file.a']],
      ['another instance', 'local_file.a[1]', []],
      ['an instance by key', 'local_file.a["x"]', []],
      ['a resource in the first instance of a module', 'module.m[0].local_file.a', ['module.m[0].local_file.a[0]', 'module.m.local_file.a', 'module.m.local_file.a[0]']],
      ['the first instance of a resource in another instance of a module', 'module.m[1].local_file.a[0]', ['module.m[1].local_file.a']],
    ])('gives where state may keep %s from before count came or went', (_, address, kept) => {
      expect(Address.parse(address).countCounterparts().map(String)).toEqual(kept);
    });
  });

  describe('ModuleAddress', () => {
    it.each([
      ['the root, as nothing', ModuleAddress.root, ''],
      ['a module', ModuleAddress.root.child('app'), 'module.app'],
      ['each module with its key', ModuleAddress.root.child('app', 0).child('db', 'x.y'), 'module.app[0].module.db["x.y"]'],
    ])('writes %s', (_, module, written) => {
      expect(module.toString()).toBe(written);
    });

    it('writes a resource in a module instance after it', () => {
      expect(new Address(ModuleAddress.root.child('app', 'a'), 'local_file', 'b', 1).toString()).toBe('module.app["a"].local_file.b[1]');
    });

    it('drops the key of every module for the module as the configuration writes it', () => {
      expect(ModuleAddress.root.child('app', 0).child('db').child('web', 'a').withoutKeys().toString()).toBe('module.app.module.db.module.web');
    });

    it('leaves the module it grows from as it was', () => {
      const app = ModuleAddress.root.child('app');
      app.child('db');

      expect(app.toString()).toBe('module.app');
    });
  });

  describe('parseDataAddress', () => {
    it('reads a data source at the root', () => {
      const { module, type, name } = parseDataAddress('data.local_file.f');

      expect([module.toString(), type, name]).toEqual(['', 'local_file', 'f']);
    });

    it('reads the module instance a data source is in', () => {
      const { module, type, name } = parseDataAddress('module.app[0].module.db["x.y"].data.local_file.f');

      expect([module.toString(), type, name]).toEqual(['module.app[0].module.db["x.y"]', 'local_file', 'f']);
    });

    it.each([
      ['no name', 'data.local_file'],
      ['a part after the name', 'data.local_file.f.content'],
      ['a first word other than data', 'module.app.x.local_file.f'],
      ['a key', 'data.local_file.f[0]'],
    ])('refuses %s', (_, written) => {
      expect(() => parseDataAddress(written)).toThrow(`Invalid address "${written}": a data source is named data, its type and its name`);
    });
  });

  describe('isModulePath', () => {
    it.each([
      ['no modules', []],
      ['modules with and without a key', [{ name: 'app', key: 0 }, { name: 'db' }, { name: 'web', key: 'a' }]],
    ])('takes %s', (_, value) => {
      expect(isModulePath(value)).toBe(true);
    });

    it.each([
      ['a name alone, not a step', ['app']],
      ['a step with no name', [{ key: 0 }]],
      ['a key that is no key', [{ name: 'app', key: -1 }]],
      ['a step that is null', [null]],
      ['no list', { name: 'app' }],
    ])('refuses %s', (_, value) => {
      expect(isModulePath(value)).toBe(false);
    });
  });
});
