package main

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

	var tableName = ""
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='EnergyData';").Scan(&tableName)

	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("error checking if table exists: %w", err)
	}

	if tableName == "" {
		_, err := db.Exec(`CREATE TABLE EnergyData (
			timestamp DATETIME PRIMARY KEY,
			load_power REAL,
			solar_power REAL,
			grid_power REAL,
			battery_power REAL
		);`)

		if err != nil {
			return fmt.Errorf("error creating sqllite table: %w", err)
		}

		logger.Debug("database and table created")
	}

	return nil
}

func (d Database) DeleteDb() error {
	d.db.Close()
	return os.Remove(d.dbfile)
}
