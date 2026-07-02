import { afterEach, describe, expect, it, vi } from 'vitest';

type CachedPool = {
  end: () => Promise<void>;
};

const dbGlobal = globalThis as typeof globalThis & { pool?: CachedPool };
const originalDatabaseUrl = process.env.DATABASE_URL;

async function clearCachedPool() {
  if (dbGlobal.pool) {
    await dbGlobal.pool.end();
    delete dbGlobal.pool;
  }
}

describe('database configuration', () => {
  afterEach(async () => {
    await clearCachedPool();
    vi.resetModules();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('fails fast when DATABASE_URL is missing', async () => {
    vi.resetModules();
    delete process.env.DATABASE_URL;

    await expect(import('./db')).rejects.toThrow('DATABASE_URL is required');
  });
});
