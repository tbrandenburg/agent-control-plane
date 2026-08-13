import { describe, expect, it } from 'vitest';
import { loadConfig, PLATFORM_CONFIG_REPO } from './config.js';

describe('loadConfig', () => {
  it('resolves defaults when env vars are absent', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: 3000,
      dataDir: './data',
      platformConfigRepo: PLATFORM_CONFIG_REPO,
    });
  });

  it('resolves overrides from env vars', () => {
    const config = loadConfig({
      PORT: '4000',
      DATA_DIR: '/var/data',
      PLATFORM_CONFIG_REPO: 'https://example.test/platform.git',
    });

    expect(config).toEqual({
      port: 4000,
      dataDir: '/var/data',
      platformConfigRepo: 'https://example.test/platform.git',
    });
  });
});
