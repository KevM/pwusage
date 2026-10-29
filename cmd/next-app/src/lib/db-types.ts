export interface User {
  id: string; // Tesla User ID or Email
  email?: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at?: number;
  is_refreshing?: number;
  refresh_lock_expires?: number;
  tesla_credential_generation?: number;
  tesla_refresh_attempt_id?: string | null;
  tesla_refresh_state?: 'ready' | 'in_flight' | 'uncertain' | 'reconnect_required';
  tesla_refresh_started_at?: Date | null;
  tesla_refresh_retry_after?: number;
  created_at?: number | string; // Added via migration
  roles?: string[]; // Added: 'admin' | 'user'
  is_active?: boolean;
  auth_status?: string;
  last_checked_at?: Date | string;
  /** Tesla access lost / restored (`stamp_user_auth_outage` trigger); lost after restored = current outage. */
  auth_lost_at?: Date | null;
  auth_restored_at?: Date | null;
  session_version?: number; // Bumped on sign-out-everywhere; embedded in site_auth JWT as `sv`
}

export interface Site {
  tesla_refresh_state?: User['tesla_refresh_state'];
  refresh_lock_expires?: number;
  id: string;
  user_id?: string | null; // FK to User
  name: string;
  utility?: string | null;
  updated: Date;
  installed: Date;
  timezone: string;
  json: unknown | null; // pg jsonb returns object
  billing_start_day: number;
  timezone_display_mode?: 'SITE' | 'BROWSER';
  sankey_renderer?: string;
  import_lock_id?: string | null;
  import_lock_expires?: number | string;
  last_import_at?: number | string;
  last_live_refresh_at?: number | string;
  last_live_claim_at?: number | string;
  live_status_cache?: unknown | null;
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
  id?: number;
  timestamp: Date;
  site_id: string;
  tariff_id: number;
  tariff_schedule_id: number | null;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
  battery_soc: number | null;
  sample_count?: number;
  sample_timestamp?: Date;
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
  access_token?: string | null;
  refresh_token?: string | null;
  auth_status?: string | null;
  /** The owner's regional Fleet API host (null = unknown, North America). */
  fleet_api_base_url?: string | null;
}

export interface LoadTag {
  id: number;
  site_id: string; // references Site(id)
  start_time: Date;
  end_time: Date;
  tag: string;
  created_at: Date;
}

export interface BatteryHold {
    restore_attempted_at?: Date | null;
  monitoring?: import('./battery-hold-monitoring').BatteryHoldMonitoring | null;
  id: number;
  site_id: string;
  status: 'active' | 'restored' | 'cancelled';
  mode: 'auto' | 'timer';
  original_reserve: number;
  target_reserve: number;
  parked_soc: number;
  baseline_load_w: number;
  restore_reason: 'load_ended' | 'no_load_detected' | 'manual' | 'safety_timeout' | 'timer_elapsed' | 'reserve_changed' | null;
  created_at: Date;
  restored_at: Date | null;
  safety_expires_at: Date;
  acknowledged_at: Date | null;
  cancelled_observed_reserve: number | null;
}
