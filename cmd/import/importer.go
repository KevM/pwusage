package main

import (
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Importer struct {
	logger *slog.Logger
	client *fleetapi.FleetApiClient
	dbfile string
}

func NewImporter(token string, dbfile string, logger *slog.Logger) *Importer {
	client := fleetapi.NewFleetApiClient(token, logger)

	return &Importer{logger: logger, client: &client, dbfile: dbfile}
}

func (i Importer) LoadSite(db *Database, siteid string) (*Site, error) {
	info, err := i.client.GetEnergySiteInfo(siteid)
	if err != nil {
		return nil, fmt.Errorf("error getting energy site info: %w", err)
	}
	repo := NewEnergyRepo(db)
	site, err := repo.UpsertSite(siteid, info)
	if err != nil {
		return nil, fmt.Errorf("error upserting site info: %w", err)
	}
	logger.Debug("site upserted", slog.Any("site", site))

	return site, nil
}

func (i Importer) LoadFullSiteHistory(db *Database, site *Site) error {
	start := time.Date(site.Installed.Year(), site.Installed.Month(), site.Installed.Day(), 0, 0, 0, 0, site.Location)
	end := time.Now().In(site.Location)
	for _, sod := range dateRange(start, end) {
		logger.Debug("loading history", slog.String("date", sod.Format("2006-01-02")))
		err := i.LoadSiteHistoryDay(db, sod, site)
		if err != nil {
			return fmt.Errorf("error loading site history for date %s: %w", sod.Format("2006-01-02"), err)
		}
	}

	return nil
}

func (i Importer) LoadSiteHistoryDay(db *Database, sod time.Time, site *Site) error {
	err := deleteDay(db.Conn(), sod)
	if err != nil {
		return fmt.Errorf("error deleting day for date %s: %w", sod.Format("2006-01-02"), err)
	}

	eod := time.Date(sod.Year(), sod.Month(), sod.Day(), 23, 59, 59, 9999, sod.Location())
	results, err := i.client.GetEnergyHistory(site.Id, sod, eod, fleetapi.HistoryPeriod_Day, sod.Location())
	if err != nil {
		return fmt.Errorf("error getting energy history for date %s: %w", sod.Format("2006-01-02"), err)
	}
	err = insertResults(db.Conn(), site.Id, results)
	if err != nil {
		return fmt.Errorf("error inserting results for date %s: %w", sod.Format("2006-01-02"), err)
	}

	return nil
}

func dateRange(start, end time.Time) []time.Time {
	var dates []time.Time

	// Normalize start to the beginning of the day
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, start.Location())

	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		dates = append(dates, d)
	}

	return dates
}

func deleteDay(db *sql.DB, sod time.Time) error {
	_, err := db.Exec(`DELETE FROM EnergyData WHERE timestamp >= ? AND timestamp < ?`, sod, sod.AddDate(0, 0, 1))
	if err != nil {
		return err
	}

	return nil
}

func insertResults(db *sql.DB, siteid string, histories []fleetapi.EnergyHistoryEntry) error {
	stmt, err := db.Prepare(`INSERT INTO EnergyData(site_id, timestamp, load_power, solar_power, grid_power, battery_power) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, h := range histories {
		var grid float64
		if h.GridEnergyImported > 0 {
			grid = h.GridEnergyImported
		} else {
			grid = 0 - h.TotalGridEnergyExported
		}

		var battery float64
		if h.TotalBatteryCharge > 0 {
			battery = h.TotalBatteryCharge
		} else {
			battery = 0 - h.TotalBatteryDischarge
		}

		_, err := stmt.Exec(siteid, h.Timestamp, h.TotalHomeUsage, h.SolarEnergyExported, grid, battery)
		if err != nil {
			return err
		}
	}

	return nil
}
