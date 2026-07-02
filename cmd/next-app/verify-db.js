const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

try {
    const envConfig = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            process.env[key] = value;
        }
    });
} catch (e) {
    console.error('Failed to read .env:', e);
}

// Build SSL config dynamically to match db.ts
const sslConfig = (() => {
    if (process.env.DATABASE_SSL_CA) {
        return {
            rejectUnauthorized: true,
            ca: process.env.DATABASE_SSL_CA,
        };
    }
    if (process.env.DATABASE_SSL_CA_FILE) {
        try {
            const fileContent = fs.readFileSync(path.resolve(process.env.DATABASE_SSL_CA_FILE), 'utf8');
            return {
                rejectUnauthorized: true,
                ca: fileContent,
            };
        } catch (err) {
            console.warn(`Failed to read database SSL CA file at ${process.env.DATABASE_SSL_CA_FILE}:`, err);
        }
    }
    // Check default locations
    const defaultPaths = [
        path.join(process.cwd(), 'certs/supabase-ca.crt'),
        path.join(process.cwd(), 'certs/prod-ca-2021.crt'),
        path.join(__dirname, 'certs/supabase-ca.crt'),
        path.join(__dirname, 'certs/prod-ca-2021.crt'),
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
                console.warn(`Failed to read database SSL CA file at ${certPath}:`, err);
            }
        }
    }
    // Insecure fallback
    console.warn('[DB] Warning: SSL CA certificate is not pinned. Bypassing TLS verification.');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    return {
        rejectUnauthorized: false,
    };
})();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
});

(async () => {
    try {
        const client = await pool.connect();
        console.log('Successfully connected to database!');
        const res = await client.query('SELECT NOW()');
        console.log('Server time:', res.rows[0].now);
        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Connection failed:', err);
        process.exit(1);
    }
})();
