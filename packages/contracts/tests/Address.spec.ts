import { describe, expect, it } from 'vitest';

import { Address } from '../src/index';

describe('Address', () => {
  describe('toString', () => {
    it('should format root resource correctly', () => {
      const addr = new Address([], 'aws_instance', 'web');
      expect(addr.toString()).toBe('aws_instance.web');
    });

    it('should format module resource correctly', () => {
      const addr = new Address(['vpc'], 'aws_subnet', 'main');
      expect(addr.toString()).toBe('module.vpc.aws_subnet.main');
    });

    it('should format nested module resource correctly', () => {
      const addr = new Address(['core', 'net'], 'aws_vpc', 'main');
      expect(addr.toString()).toBe('module.core.module.net.aws_vpc.main');
    });

    it.each([
      ['a number', 0, 'local_file.a[0]'],
      ['a string', 'blog', 'local_file.a["blog"]'],
      ['a string with a dot in it', 'x.y', 'local_file.a["x.y"]'],
      ['a string with a quote and a backslash in it, escaped', 'say "hi" \\', String.raw`local_file.a["say \"hi\" \\"]`],
    ])('writes an instance key that is %s after the name', (_, key, written) => {
      expect(new Address([], 'local_file', 'a', key).toString()).toBe(written);
    });

    it('writes an instance key of a resource in a module', () => {
      expect(new Address(['app'], 'local_file', 'a', 1).toString()).toBe('module.app.local_file.a[1]');
    });
  });

  describe('parse', () => {
    it('should parse root resource string', () => {
      const addr = Address.parse('aws_instance.web');
      expect(addr.modulePath).toEqual([]);
      expect(addr.resourceType).toBe('aws_instance');
      expect(addr.name).toBe('web');
    });

    it('should parse module resource string', () => {
      const addr = Address.parse('module.vpc.aws_subnet.private');
      expect(addr.modulePath).toEqual(['vpc']);
      expect(addr.resourceType).toBe('aws_subnet');
      expect(addr.name).toBe('private');
    });

    it('should parse nested module string', () => {
      const addr = Address.parse('module.app.module.db.aws_db_instance.main');
      expect(addr.modulePath).toEqual(['app', 'db']);
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
      expect(Address.parse(input)).toEqual(new Address([], 'local_file', 'a', key));
    });

    it('reads the instance key of a resource in a module', () => {
      expect(Address.parse('module.app.local_file.a[1]')).toEqual(new Address(['app'], 'local_file', 'a', 1));
    });

    it.each(['local_file.a', 'module.app.local_file.a[3]', 'local_file.a["x.y"]', String.raw`local_file.a["say \"hi\" \\"]`])('reads back what it writes: %s', (input) => {
      expect(Address.parse(input).toString()).toBe(input);
    });

    it.each([
      ['local_file.a[', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[-1]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[01]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[1.5]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[blog]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a["blog]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a["a"]["b"]', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[0].b', 'a key is a whole number or a quoted string, as in [0] or ["name"]'],
      ['local_file.a[9007199254740992]', 'a key is at most 9007199254740991'],
      ['local_file.a["a" ]', 'a key is written as ["a"]'],
      [String.raw`local_file.a["\u0062"]`, 'a key is written as ["b"]'],
      ['module.app[0].local_file.a', 'a module has no instances, so it takes no key'],
      ['module.app[0]', 'a module has no instances, so it takes no key'],
      ['local_file[0].a', 'a key comes after the name'],
    ])('refuses the key in %s and says what is wrong', (input, reason) => {
      expect(() => Address.parse(input)).toThrow(`Invalid address "${input}": ${reason}`);
    });

    it.each([
      ['invalid', 'Invalid address "invalid": an address ends with a type and a name'],
      ['module.vpc', 'Invalid address "module.vpc": an address ends with a type and a name'],
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
});
