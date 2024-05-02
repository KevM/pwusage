package fleetdb

import (
	"database/sql"
	"fmt"
	"os"
)

type Database struct {
	db     *sql.DB
	dbfile string
}

func NewDatabase(dbfile string) (*Database, error) {
	db, err := sql.Open("sqlite3", dbfile)
	if err != nil {
		return nil, fmt.Errorf("error opening sqllite db file %s: %w", dbfile, err)
	}

	err = setupDb(db)
	if err != nil {
		return nil, fmt.Errorf("error setting up sqllite db: %w", err)
	}

	return &Database{db: db, dbfile: dbfile}, nil
}

func (d Database) Conn() *sql.DB {
	return d.db
}

func (d Database) Close() error {
	return d.db.Close()
}

func setupDb(db *sql.DB) error {

	// being so clever putting the last created table here to force a setup :o
	var tableName = ""
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='EnergyUsage';").Scan(&tableName)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("error checking if table exists: %w", err)
	}

	if tableName != "" {
		return nil
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS Site (
		id TEXT PRIMARY KEY,
		updated DATETIME NOT NULL,
		installed DATETIME NOT NULL,
		timezone TEXT NOT NULL,
		json JSON
	);`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS Tariff (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		site_id TEXT NOT NULL,
		updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		name TEXT,
		FOREIGN KEY (site_id) REFERENCES Site(id) ON DELETE CASCADE,
		UNIQUE(site_id, name)
	);`)
	if err != nil {
		return err
	}

	// tariff -> season
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS TariffSeason (
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
	);`)
	if err != nil {
		return err
	}

	// tariff -> season -> schedule
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS TariffSchedule (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		season_id INTEGER NOT NULL,
		from_day_of_week INTEGER,
		from_hour INTEGER,
		from_minute INTEGER,
		to_day_of_week INTEGER,
		to_hour INTEGER,
		to_minute INTEGER,
		FOREIGN KEY (season_id) REFERENCES TariffSeason(id) ON DELETE CASCADE
	);`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS EnergyData (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp DATETIME NOT NULL,
		tariff_id INTEGER NOT NULL,
		load_power REAL NOT NULL,
		solar_power REAL NOT NULL,
		grid_power REAL NOT NULL,
		battery_power REAL NOT NULL,
		FOREIGN KEY (tariff_id) REFERENCES Tariff(id) ON DELETE CASCADE,
		UNIQUE(timestamp, tariff_id)
	);`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS EnergyUsage (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tariff_id INTEGER NOT NULL,
		start DATETIME NOT NULL, 
		load_usage REAL NOT NULL,
		solar_produced REAL NOT NULL,
		grid_usage REAL NOT NULL,
		battery_usage REAL NOT NULL,
		FOREIGN KEY (tariff_id) REFERENCES Tariff(id) ON DELETE CASCADE,
		UNIQUE(tariff_id, start)
	);`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS BatteryHold (
		site_id TEXT PRIMARY KEY,
		created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		battery_reserve_before_hold INTEGER NOT NULL,
		battery_soe_at_hold INTEGER NOT NULL,
		FOREIGN KEY (site_id) REFERENCES Site(id) ON DELETE CASCADE
	);`)
	if err != nil {
		return err
	}

	return nil
}

func (d Database) DeleteDb() error {
	d.db.Close()
	return os.Remove(d.dbfile)
}
