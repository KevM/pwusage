import Database from 'better-sqlite3';
import path from 'path';

// In development, we want to preserve the connection across reloads
// In production, it's created once per process
const globalForDb = global as unknown as { db: Database.Database };

const dbPath = process.env.DATABASE_URL?.replace('file:', '') || '../../pwrtool/pwusage.db';
// Resolve path relative to cwd if it's relative
const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

export const db = globalForDb.db || new Database(resolvedPath, { verbose: console.log });

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
