import { Pool } from 'pg';

// Force int8 to be parsed as number (if fits) or string? 
// By default pg parses bigint as string. We can leave it or force it.
// Date parsing: pg returns Date objects for timestamptz/timestamp.

const globalForDb = global as unknown as { pool: Pool };

// Hack to strip sslmode=require from connection string if present, 
// relying on the object config below instead.
let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
  connStr = connStr.replace('sslmode=require', '');
}

export const pool = globalForDb.pool || new Pool({
  connectionString: connStr,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Add error handler to prevent crashing on idle client errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // Don't process.exit() here; just log it. 
  // The pool will discard the client and create a new one when needed.
});

if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

export function getDb() {
  return pool;
}


export interface User {
  id: string; // Tesla User ID or Email
  email?: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at?: number;
  is_refreshing?: number;
  refresh_lock_expires?: number;
  created_at?: number | string; // Added via migration
  roles?: string[]; // Added: 'admin' | 'user'
}

export interface Site {
  id: string;
  user_id?: string | null; // FK to User
  name: string;
  updated: Date;
  installed: Date;
  timezone: string;
  json: unknown | null; // pg jsonb returns object
  billing_start_day: number;
}

export interface Tariff {
  id: number;
  site_id: string;
  updated: Date;
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

export interface EnergyData {
  id: number;
  timestamp: Date;
  site_id: string;
  tariff_id: number;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
  battery_soc: number | null;
  is_synthetic?: number;
}



export interface TrmnlInstallation {
  id: number;
  uuid: string | null;
  site_id: string;
  plugin_setting_id: number | null;
  created_at: Date;
  json?: unknown;
  access_token?: string | null;
  refresh_token?: string | null;
}

export interface SiteWithTariffs extends Site {
  tariffs: Tariff[];
}

export interface LoadTag {
  id: number;
  site_id: string; // references Site(id)
  start_time: Date;
  end_time: Date;
  tag: string;
  created_at: Date;
}
