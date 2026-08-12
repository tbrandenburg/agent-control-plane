import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('resolves defaults when env vars are absent', () => {
    const config = loadConfig({});

    expect(config).toEqual({ port: 3000, dataDir: './data' });
  });

  it('resolves overrides from env vars', () => {
    const config = loadConfig({ PORT: '4000', DATA_DIR: '/var/data' });

    expect(config).toEqual({ port: 4000, dataDir: '/var/data' });
  });
});
