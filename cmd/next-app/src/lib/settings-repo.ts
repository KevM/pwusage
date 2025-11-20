import { db } from './db';

export class SettingsRepo {
    constructor() {
        this.init();
    }

    private init() {
        db.exec(`
      CREATE TABLE IF NOT EXISTS AppSettings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    }

    getBillingStartDay(): number {
        const row = db.prepare("SELECT value FROM AppSettings WHERE key = 'billing_start_day'").get() as { value: string } | undefined;
        if (!row) return 1; // Default to 1st of the month
        return parseInt(row.value, 10);
    }

    setBillingStartDay(day: number) {
        db.prepare(`
      INSERT INTO AppSettings (key, value) VALUES ('billing_start_day', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(day.toString());
    }
}
