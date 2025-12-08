import { pool } from './db';

interface AppSettingsCache {
  billing_start_day?: string;
  [key: string]: string | undefined;
}

export class SettingsRepo {
  private static cache: AppSettingsCache | null = null;
  private static cacheExpires: number = 0;
  private static CACHE_TTL = 60 * 1000; // 1 minute

  constructor() {
    // No sync init needed
  }

  static invalidate() {
    SettingsRepo.cache = null;
    SettingsRepo.cacheExpires = 0;
    console.log('[SettingsRepo] Cache invalidated');
  }

  private async ensureCache() {
    const now = Date.now();
    if (SettingsRepo.cache && SettingsRepo.cacheExpires > now) {
      return;
    }

    console.log('[SettingsRepo] Loading settings from DB');
    const { rows } = await pool.query('SELECT key, value FROM "AppSettings"');
    const newCache: AppSettingsCache = {};
    rows.forEach((r: any) => {
      newCache[r.key] = r.value;
    });

    SettingsRepo.cache = newCache;
    SettingsRepo.cacheExpires = now + SettingsRepo.CACHE_TTL;
  }

  private async getCached(key: string): Promise<string | undefined> {
    await this.ensureCache();
    return SettingsRepo.cache?.[key];
  }

  private async setCached(key: string, value: string) {
    await pool.query(`
            INSERT INTO "AppSettings" (key, value) VALUES ($1, $2)
            ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
        `, [key, value]);

    // Update cache if it exists
    if (SettingsRepo.cache) {
      SettingsRepo.cache[key] = value;
    }
  }

  async getBillingStartDay(): Promise<number> {
    const val = await this.getCached('billing_start_day');
    if (!val) return 1; // Default
    return parseInt(val, 10);
  }

  async setBillingStartDay(day: number): Promise<void> {
    await this.setCached('billing_start_day', day.toString());
  }
}
