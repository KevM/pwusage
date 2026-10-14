import { ioSignal, checkIoDeadline, abortable } from './io-deadline';
import { Pool, PoolConfig, type PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

// Force int8 to be parsed as number (if fits) or string? 
// By default pg parses bigint as string. We can leave it or force it.
// Date parsing: pg returns Date objects for timestamptz/timestamp.

const globalForDb = global as unknown as { pool: Pool };

function createPool(bounded = false) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('[DB] DATABASE_URL is required to initialize the database pool.');
  }

  // Hack to strip sslmode=require from connection string if present, 
  // relying on the object config below instead.
  let connStr = databaseUrl;
  if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
  }

  // Securely resolve SSL configuration
  const sslConfig = (() => {
    // 1. Raw PEM content from env var
    if (process.env.DATABASE_SSL_CA) {
      return {
        rejectUnauthorized: true,
        ca: process.env.DATABASE_SSL_CA,
      };
    }

    // 2. Path to CA cert from env var
    if (process.env.DATABASE_SSL_CA_FILE) {
      try {
        const fileContent = fs.readFileSync(path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_SSL_CA_FILE), 'utf8');
        return {
          rejectUnauthorized: true,
          ca: fileContent,
        };
      } catch (err) {
        throw new Error(`[DB] Failed to read database SSL CA file at ${process.env.DATABASE_SSL_CA_FILE}: ${err}`);
      }
    }

    // 3. Check default locations relative to the workspace / process root
    const defaultPaths = [
      path.join(/*turbopackIgnore: true*/ process.cwd(), 'certs/supabase-ca.crt'),
      path.join(/*turbopackIgnore: true*/ process.cwd(), 'certs/prod-ca-2021.crt'),
      path.join(/*turbopackIgnore: true*/ process.cwd(), 'cmd/next-app/certs/supabase-ca.crt'),
      path.join(/*turbopackIgnore: true*/ process.cwd(), 'cmd/next-app/certs/prod-ca-2021.crt'),
    ];

    for (const certPath of defaultPaths) {
      if (fs.existsSync(/*turbopackIgnore: true*/ certPath)) {
        try {
          const fileContent = fs.readFileSync(/*turbopackIgnore: true*/ certPath, 'utf8');
          return {
            rejectUnauthorized: true,
            ca: fileContent,
          };
        } catch (err) {
          throw new Error(`[DB] Failed to read database SSL CA file at ${certPath}: ${err}`);
        }
      }
    }

    // 4. Default insecure fallback
    const isLocal = !connStr || connStr.includes('localhost') || connStr.includes('127.0.0.1') || connStr.startsWith('file:');
    if (!isLocal) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[DB] ERROR: SSL CA certificate is not pinned in production! Database connection is vulnerable to MITM attacks. Please set DATABASE_SSL_CA or DATABASE_SSL_CA_FILE.');
      } else {
        console.warn('[DB] Warning: SSL CA certificate is not pinned. Database connection is vulnerable to MITM attacks.');
      }
    }
    return {
      rejectUnauthorized: false,
    };
  })();

  const poolConfig: PoolConfig = {
    connectionString: connStr,
    ssl: sslConfig,
    // We connect through Supabase's Supavisor transaction pooler (port 6543),
    // whose max_client_connections cap (default 200) counts every client
    // connection this pool holds open. Keep max small so many concurrent warm
    // serverless instances (instances * max) stay well under that cap; the
    // pooler multiplexes these onto its own Postgres-side pool.
    max: bounded ? 3 : 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: bounded ? 1000 : 10000,
    ...(bounded ? { statement_timeout: 1500, lock_timeout: 1000, query_timeout: 2000 } : {}),
  };

  const dbPool = new Pool(poolConfig);

  // Add error handler to prevent crashing on idle client errors
  dbPool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    // Don't process.exit() here; just log it. 
    // The pool will discard the client and create a new one when needed.
  });

  // Increase max listeners for parallel query operations
  dbPool.setMaxListeners(30); // Increased a bit more for safety

  // Cache the pool in every environment. In dev this survives HMR; in
  // production it makes the Proxy's per-access getPool() reuse one pool per
  // warm instance instead of constructing (and leaking) a new Pool on every
  // query, which was exhausting Postgres connections (EMAXCONN, limit 200).
  if (!bounded) globalForDb.pool = dbPool;

  return dbPool;
}

let boundedPool: Pool | undefined;
function getPool() {
  if (ioSignal()) return boundedPool ??= createPool(true);
  if (globalForDb.pool) {
    return globalForDb.pool;
  }

  return createPool();
}

async function connectWithinDeadline(dbPool: Pool, signal: AbortSignal): Promise<PoolClient> {
  signal.throwIfAborted();
  const acquiring = dbPool.connect().then(client => {
    if (signal.aborted) { client.release(true); signal.throwIfAborted(); }
    return client;
  });
  return abortable(acquiring, signal);
}

const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    checkIoDeadline();
    const dbPool = getPool();
    if (prop === 'connect' && ioSignal()) {
      return async () => {
        checkIoDeadline();
        const signal = ioSignal()!;
        const client = await connectWithinDeadline(dbPool, signal);
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query') return (...args: unknown[]) => {
              signal.throwIfAborted();
              return abortable(Reflect.apply(target.query, target, args) as Promise<unknown>, signal);
            };
            if (key === 'release') return (destroy?: boolean) => target.release(destroy || signal.aborted);
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as PoolClient;
      };
    }
    if (prop === 'query' && ioSignal()) {
      return async (...args: unknown[]) => {
        const signal = ioSignal()!;
        const client = await connectWithinDeadline(dbPool, signal);
        try {
          signal.throwIfAborted();
          return await abortable(Reflect.apply(client.query, client, args) as Promise<unknown>, signal);
        } finally { client.release(signal.aborted); }
      };
    }
    const value = Reflect.get(dbPool, prop, dbPool);
    return typeof value === 'function' ? value.bind(dbPool) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(getPool(), prop, value);
  },
}) as Pool;

export { pool };

export function getDb() {
  return getPool();
}

/**
 * True when `error` is a Postgres unique-constraint violation (SQLSTATE 23505),
 * e.g. from idx_user_email_lower on "User"(LOWER(email)).
 */
export function isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === '23505';
}

// Re-export all database row types
export * from './db-types';

