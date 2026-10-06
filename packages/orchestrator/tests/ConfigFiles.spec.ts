import { describe, expect, it } from 'vitest';

import { ConfigFiles, RecordingFiles } from '../src/ConfigFiles';

describe('RecordingFiles', () => {
  it('gives the content it read first when the file changes after', () => {
    let content = 'first';
    const source: ConfigFiles = { read: () => content };
    const files = new RecordingFiles(source);

    files.read('main.clay');
    content = 'second';

    expect(files.read('main.clay')).toBe('first');
  });
});
