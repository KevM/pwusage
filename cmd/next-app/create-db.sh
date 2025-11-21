
sqlite3 /Users/kevm/github/pwusage/cmd/next-app/pwusage.db <<'SQL'
PRAGMA foreign_keys = ON;
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
SQL
