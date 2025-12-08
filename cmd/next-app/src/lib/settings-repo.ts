import { db } from './db';

interface AppSettingsCache {
}

export class SettingsRepo {
  private static cache: AppSettingsCache | null = null;
  private static cacheExpires: number = 0;
  private static CACHE_TTL = 60 * 1000; // 1 minute

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

  static invalidate() {
    SettingsRepo.cache = null;
    SettingsRepo.cacheExpires = 0;
    console.log('[SettingsRepo] Cache invalidated');
  }

  private ensureCache() {
    const now = Date.now();
    if (SettingsRepo.cache && SettingsRepo.cacheExpires > now) {
      return;
    }

    console.log('[SettingsRepo] Loading settings from DB');
    const rows = db.prepare("SELECT key, value FROM AppSettings").all() as { key: string, value: string }[];
    const newCache: AppSettingsCache = {};
    rows.forEach(r => {
      // We can safely cast here or check keys if we want to be very strict
      (newCache as any)[r.key] = r.value;
    });

    SettingsRepo.cache = newCache;
    SettingsRepo.cacheExpires = now + SettingsRepo.CACHE_TTL;
  }

  private getCached(key: keyof AppSettingsCache): string | undefined {
    this.ensureCache();
    return SettingsRepo.cache?.[key];
  }

  private setCached(key: keyof AppSettingsCache, value: string) {
    db.prepare(`
      INSERT INTO AppSettings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);

    // Update cache if it exists
    if (SettingsRepo.cache) {
      SettingsRepo.cache[key] = value;
    }
  }


}
