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

  it('can be imported without DATABASE_URL but fails fast before querying', async () => {
    vi.resetModules();
    delete process.env.DATABASE_URL;

    const { pool } = await import('./db');

    expect(() => pool.query('SELECT 1')).toThrow('DATABASE_URL is required');
  });
});

describe('isUniqueViolation', () => {
    it('returns true for a pg unique-violation error (code 23505)', async () => {
        const { isUniqueViolation } = await import('./db');
        const err = Object.assign(new Error('duplicate key value violates unique constraint "idx_user_email_lower"'), { code: '23505' });
        expect(isUniqueViolation(err)).toBe(true);
    });

    it('returns false for other pg errors, plain errors, and non-errors', async () => {
        const { isUniqueViolation } = await import('./db');
        expect(isUniqueViolation(Object.assign(new Error('fk violation'), { code: '23503' }))).toBe(false);
        expect(isUniqueViolation(new Error('boom'))).toBe(false);
        expect(isUniqueViolation(null)).toBe(false);
        expect(isUniqueViolation('23505')).toBe(false);
    });
});

