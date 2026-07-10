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

  it('reuses a single Pool across queries in production instead of leaking one per query', async () => {
    vi.resetModules();
    const originalNodeEnv = process.env.NODE_ENV;
    // Reproduce the Vercel runtime: NODE_ENV=production with a remote-looking URL.
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';

    let constructed = 0;
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.doMock('pg', () => ({
      Pool: class {
        constructor() {
          constructed++;
        }
        on() {
          return this;
        }
        setMaxListeners() {
          return this;
        }
        query = query;
        end = vi.fn().mockResolvedValue(undefined);
      },
    }));

    try {
      const { pool } = await import('./db');
      await pool.query('SELECT 1');
      await pool.query('SELECT 1');
      await pool.query('SELECT 1');

      // Each query goes through the Proxy -> getPool(); without a cached pool in
      // production every access builds a fresh Pool and leaks its connections,
      // which is what exhausts Postgres (EMAXCONN, limit 200).
      expect(constructed).toBe(1);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      vi.doUnmock('pg');
    }
  });

  it('caps the client pool small enough that many warm instances stay under the Supavisor 200-client limit', async () => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';

    const configs: Array<{ max?: number }> = [];
    vi.doMock('pg', () => ({
      Pool: class {
        constructor(config: { max?: number }) {
          configs.push(config);
        }
        on() {
          return this;
        }
        setMaxListeners() {
          return this;
        }
        query = vi.fn().mockResolvedValue({ rows: [] });
        end = vi.fn().mockResolvedValue(undefined);
      },
    }));

    try {
      const { pool } = await import('./db');
      await pool.query('SELECT 1');

      // Behind Supavisor's transaction pooler (port 6543) each client connection
      // counts against the pooler's max_client_connections cap (default 200).
      // Keep max small so N concurrent warm serverless instances (N * max) stay
      // well under that cap.
      expect(configs[0]?.max).toBeLessThanOrEqual(10);
    } finally {
      vi.doUnmock('pg');
    }
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

