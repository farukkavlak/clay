import { UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { inconsistent } from '../../src/providers/providerResult';

describe('inconsistent', () => {
  const mismatches = [
    { path: ['label'], planned: 'hunter2', returned: UNKNOWN },
    { path: ['triggers', 'token'], planned: 'hunter2', returned: 'hunter3' },
    { path: ['triggers', 'name'], planned: 'app', returned: 'web' },
  ];
  const sensitive = [['label'], ['triggers', 'token']];

  it('names a sensitive part of a plan made again, and quotes neither value', () => {
    expect(inconsistent('named', 'plan', mismatches, sensitive).message).toBe(
      [
        'named planned at apply what the plan did not show, which is a bug in the provider:',
        '  label: inconsistent values for sensitive attribute',
        '  triggers["token"]: inconsistent values for sensitive attribute',
        '  triggers["name"] = "web", where the plan showed "app"',
      ].join('\n')
    );
  });

  it('names a sensitive part of an apply result the same way', () => {
    expect(inconsistent('named', 'apply', mismatches, sensitive).message).toContain('  triggers["token"]: inconsistent values for sensitive attribute');
  });

  it('quotes a value where nothing is sensitive', () => {
    expect(inconsistent('named', 'plan', mismatches, []).message).toContain('  label is not known, where the plan showed "hunter2"');
  });
});
