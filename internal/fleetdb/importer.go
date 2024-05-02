package fleetdb

import (
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Importer struct {
	logger *slog.Logger
	client *fleetapi.Client
}

func NewImporter(client *fleetapi.Client, logger *slog.Logger) *Importer {
	return &Importer{logger: logger, client: client}
}

func (i Importer) LoadFullSiteHistory(db *Database, site *Site) error {
	start := time.Date(site.Installed.Year(), site.Installed.Month(), site.Installed.Day(), 0, 0, 0, 0, site.Location)
	end := time.Now().In(site.Location)
	for _, sod := range dateRange(start, end) {
		i.logger.Debug("loading history", slog.String("date", sod.Format("2006-01-02")))
		err := i.LoadSiteHistoryDay(db, sod, site)
		if err != nil {
			return fmt.Errorf("error loading site history for date %s: %w", sod.Format("2006-01-02"), err)
		}
	}

	return nil
}

func (i Importer) LoadSiteHistoryDay(db *Database, sod time.Time, site *Site) error {
	usage := NewUsage(site, db, i.client, i.logger)

	err := deleteDay(db.Conn(), sod)
	if err != nil {
		return fmt.Errorf("error deleting day for date %s: %w", sod.Format("2006-01-02"), err)
	}

	eod := time.Date(sod.Year(), sod.Month(), sod.Day(), 23, 59, 59, 9999, sod.Location())
	results, err := i.client.GetEnergyHistory(site.Id, sod, eod, fleetapi.HistoryPeriod_Day, sod.Location())
	if err != nil {
		return fmt.Errorf("error getting energy history for date %s: %w", sod.Format("2006-01-02"), err)
	}
	ed, err := insertEnergyDatas(db.Conn(), site, results)
	if err != nil {
		return fmt.Errorf("error inserting results for date %s: %w", sod.Format("2006-01-02"), err)
	}

	usages := usage.GetUsagesFromData(site, ed)
	err = insertEnergyUsages(db.Conn(), usages)
	if err != nil {
		return fmt.Errorf("error inserting usages for date %s: %w", sod.Format("2006-01-02"), err)
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

func insertEnergyUsages(db *sql.DB, usages []UsageData) error {
	stmt, err := db.Prepare(`INSERT INTO EnergyUsage(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, u := range usages {
		_, err := stmt.Exec(u.Tariff.Id, u.Start, u.HomeUsage, u.SolarProduction, u.GridUsage, u.BatteryChange)
		if err != nil {
			return err
		}
	}

	return nil
}

func insertEnergyDatas(db *sql.DB, site *Site, histories []fleetapi.EnergyHistoryEntry) ([]EnergyData, error) {
	schedule := NewSchedule(site.Tariffs)
	stmt, err := db.Prepare(`INSERT INTO EnergyData(tariff_id, timestamp, load_power, solar_power, grid_power, battery_power) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	var results []EnergyData
	for _, h := range histories {
		tp := schedule.GetTariffPeriod(h.Timestamp)
		if tp == nil {
			return nil, fmt.Errorf("no tariff period found for %s", h.Timestamp)
		}

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

		_, err := stmt.Exec(tp.Tariff.Id, h.Timestamp, h.TotalHomeUsage, h.SolarEnergyExported, grid, battery)
		if err != nil {
			return nil, err
		}

		ed := EnergyData{
			Timestamp:    h.Timestamp,
			TariffId:     tp.Tariff.Id,
			LoadPower:    h.TotalHomeUsage,
			SolarPower:   h.SolarEnergyExported,
			GridPower:    grid,
			BatteryPower: battery,
		}
		results = append(results, ed)
	}

	return results, nil
}
