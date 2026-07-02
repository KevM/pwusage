import './bootstrap-env';
import { pool } from '../src/lib/db';

(async () => {
    try {
        console.log('Testing database connectivity...');
        const client = await pool.connect();
        console.log('Successfully connected to database!');
        const res = await client.query('SELECT NOW()');
        console.log('Server time:', res.rows[0].now);
        client.release();
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('Connection failed:', err);
        process.exit(1);
    }
})();
