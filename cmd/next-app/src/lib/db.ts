import Database from 'better-sqlite3';
import path from 'path';

// In development, we want to preserve the connection across reloads
// In production, it's created once per process
const globalForDb = global as unknown as { db: Database.Database };

import fs from 'fs';

// Default to app-local db; override via DATABASE_URL (file:... or plain path)
const dbPathEnv = process.env.DATABASE_URL;
const dbPath = dbPathEnv ? dbPathEnv.replace('file:', '') : './pwusage.db';
// Resolve path relative to cwd if it's relative
const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
console.log(`[DB] Initialize. Resolved Path: ${resolvedPath}. CWD: ${process.cwd()}`);


// Cleanup stale WAL files if the main DB file is missing
if (!fs.existsSync(resolvedPath)) {
  const walPath = `${resolvedPath}-wal`;
  const shmPath = `${resolvedPath}-shm`;
  if (fs.existsSync(walPath)) {
    try { fs.unlinkSync(walPath); console.log('Deleted stale WAL file'); } catch (e) { console.error('Failed to delete stale WAL file', e); }
  }
  if (fs.existsSync(shmPath)) {
    try { fs.unlinkSync(shmPath); console.log('Deleted stale SHM file'); } catch (e) { console.error('Failed to delete stale SHM file', e); }
  }
}

let db: Database.Database;

try {
  db = globalForDb.db || new Database(resolvedPath, { verbose: console.log });
  // Force a small read to verify validity immediately
  db.pragma('foreign_keys = ON');
} catch (error: any) {
  console.error('Failed to open database:', error);
  if (error.code === 'SQLITE_CORRUPT' || error.message.includes('file is not a database')) {
    console.warn('Database file appears corrupted or invalid. Attempting to delete and recreate...');
    if (globalForDb.db) {
      try { globalForDb.db.close(); } catch (e) { /* ignore */ }
      globalForDb.db = undefined as any;
    }

    try {
      if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
      if (fs.existsSync(`${resolvedPath}-wal`)) fs.unlinkSync(`${resolvedPath}-wal`);
      if (fs.existsSync(`${resolvedPath}-shm`)) fs.unlinkSync(`${resolvedPath}-shm`);

      console.log('Deleted corrupted database files. Retrying creation...');
      db = new Database(resolvedPath, { verbose: console.log });
      db.pragma('foreign_keys = ON');
    } catch (retryError) {
      console.error('FATAL: Failed to recreate database after corruption handling:', retryError);
      throw retryError;
    }
  } else {
    throw error;
  }
}

export { db };

// Schema initialization
const hasSiteTable = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='Site'").get() as { count: number };

if (!hasSiteTable || hasSiteTable.count === 0) {
  console.log('Initializing database schema...');
  db.exec(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE Site (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          updated DATETIME NOT NULL,
          installed DATETIME NOT NULL,
          timezone TEXT NOT NULL,
          json JSON
        );

        CREATE TABLE Tariff (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id TEXT NOT NULL,
          updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          name TEXT,
          FOREIGN KEY (site_id) REFERENCES Site(id) ON DELETE CASCADE,
          UNIQUE(site_id, name)
        );

        CREATE TABLE TariffSeason (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tariff_id INTEGER NOT NULL,
          name TEXT,
          from_month INTEGER NOT NULL,
          from_day INTEGER NOT NULL,
          to_month INTEGER NOT NULL,
          to_day INTEGER NOT NULL,
          buy_rate REAL NOT NULL,
          sell_rate REAL NOT NULL,
          FOREIGN KEY (tariff_id) REFERENCES Tariff(id) ON DELETE CASCADE,
          UNIQUE(tariff_id, name)
        );

        CREATE TABLE TariffSchedule (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          season_id INTEGER NOT NULL,
          name TEXT,
          buy_rate REAL,
          sell_rate REAL,
          from_day_of_week INTEGER,
          from_hour INTEGER,
          from_minute INTEGER,
          to_day_of_week INTEGER,
          to_hour INTEGER,
          to_minute INTEGER,
          FOREIGN KEY (season_id) REFERENCES TariffSeason(id) ON DELETE CASCADE
        );

        CREATE TABLE EnergyData (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          site_id TEXT NOT NULL,
          tariff_id INTEGER NOT NULL,
          load_power REAL NOT NULL,
          solar_power REAL NOT NULL,
          grid_power REAL NOT NULL,
          battery_power REAL NOT NULL,
          battery_soc REAL,
          FOREIGN KEY (site_id) REFERENCES Site(id) ON DELETE CASCADE,
          FOREIGN KEY (tariff_id) REFERENCES Tariff(id) ON DELETE CASCADE,
          UNIQUE(timestamp, site_id, tariff_id)
        );

        CREATE TABLE EnergyUsage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tariff_id INTEGER NOT NULL,
          start DATETIME NOT NULL,
          load_usage REAL NOT NULL,
          solar_produced REAL NOT NULL,
          grid_usage REAL NOT NULL,
          battery_usage REAL NOT NULL,
          FOREIGN KEY (tariff_id) REFERENCES Tariff(id) ON DELETE CASCADE,
          UNIQUE(tariff_id, start)
        );

        CREATE TABLE BatteryHold (
          site_id TEXT PRIMARY KEY,
          created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          battery_reserve_before_hold INTEGER NOT NULL,
          battery_soe_at_hold INTEGER NOT NULL,
          FOREIGN KEY (site_id) REFERENCES Site(id) ON DELETE CASCADE
        );

        CREATE TABLE AppSettings (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE TrmnlInstallation (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          access_token TEXT UNIQUE NOT NULL,
          uuid TEXT UNIQUE,
          site_id TEXT NOT NULL,
          plugin_setting_id INTEGER,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
  console.log('Database schema initialized.');
}



if (process.env.NODE_ENV !== 'production') globalForDb.db = db;

// Types based on the Go structs / DB schema
export interface Site {
  id: string;
  name: string;
  updated: string; // SQLite stores dates as strings
  installed: string;
  timezone: string;
  json: string | null;
}

export interface Tariff {
  id: number;
  site_id: string;
  updated: string;
  name: string | null;
  seasons?: TariffSeason[];
}

export interface TariffSeason {
  id: number;
  tariff_id: number;
  name: string | null;
  from_month: number;
  from_day: number;
  to_month: number;
  to_day: number;
  buy_rate: number;
  sell_rate: number;
  schedules?: TariffSchedule[];
}

export interface TariffSchedule {
  id: number;
  season_id: number;
  name: string | null;
  buy_rate: number | null;
  sell_rate: number | null;
  from_day_of_week: number | null;
  from_hour: number | null;
  from_minute: number | null;
  to_day_of_week: number | null;
  to_hour: number | null;
  to_minute: number | null;
}

export interface EnergyUsage {
  id: number;
  tariff_id: number;
  start: string;
  load_usage: number;
  solar_produced: number;
  grid_usage: number;
  battery_usage: number;
}

export interface TrmnlInstallation {
  id: number;
  access_token: string;
  uuid: string | null;
  site_id: string;
  plugin_setting_id: number | null;
  created_at: string;
}
