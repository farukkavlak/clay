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
