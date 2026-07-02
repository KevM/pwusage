import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import path from 'path';

// Force int8 to be parsed as number (if fits) or string? 
// By default pg parses bigint as string. We can leave it or force it.
// Date parsing: pg returns Date objects for timestamptz/timestamp.

const globalForDb = global as unknown as { pool: Pool };

let pool: Pool;

if (globalForDb.pool) {
  pool = globalForDb.pool;
} else {
  // Hack to strip sslmode=require from connection string if present, 
  // relying on the object config below instead.
  let connStr = process.env.DATABASE_URL || '';
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
        const fileContent = fs.readFileSync(path.resolve(process.env.DATABASE_SSL_CA_FILE), 'utf8');
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
      path.join(process.cwd(), 'certs/supabase-ca.crt'),
      path.join(process.cwd(), 'certs/prod-ca-2021.crt'),
      path.join(process.cwd(), 'cmd/next-app/certs/supabase-ca.crt'),
      path.join(process.cwd(), 'cmd/next-app/certs/prod-ca-2021.crt'),
    ];

    for (const certPath of defaultPaths) {
      if (fs.existsSync(certPath)) {
        try {
          const fileContent = fs.readFileSync(certPath, 'utf8');
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
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  pool = new Pool(poolConfig);

  if (needsSetup()) {
    // Add error handler to prevent crashing on idle client errors
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      // Don't process.exit() here; just log it. 
      // The pool will discard the client and create a new one when needed.
    });

    // Increase max listeners for parallel query operations
    pool.setMaxListeners(30); // Increased a bit more for safety
  }

  if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;
}

// Helper to check setup inside else branch
function needsSetup() {
  return true;
}

export { pool };

export function getDb() {
  return pool;
}

// Re-export all database row types
export * from './db-types';
