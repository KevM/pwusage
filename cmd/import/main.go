package main

import (
	"log/slog"
	"os"
	"time"

	"database/sql"
	"fmt"

	"github.com/joho/godotenv"
	_ "github.com/mattn/go-sqlite3"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Response struct {
	Response Data `json:"response"`
}

type Data struct {
	TimeSeries []TimeSeries `json:"time_series"`
}

type TimeSeries struct {
	HomeUsage        float64 `json:"total_home_usage"`
	SolarGeneration  float64 `json:"total_solar_generation"`
	BatteryDischarge float64 `json:"total_battery_discharge"`
	GridExported     float64 `json:"total_grid_energy_exported"`
}

func main() {
	godotenv.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	var token string = ""
	if os.Getenv("FLEET_AUTH_TOKEN") != "" {
		token = os.Getenv("FLEET_AUTH_TOKEN")
	} else {
		logger.Error("Please set the FLEET_AUTH_TOKEN environment variable")
		os.Exit(1)
	}

	if len(os.Args) < 2 {
		logger.Error("Please provide a siteid to import")
		os.Exit(2)
	}

	siteid := os.Args[1]

	// db, err := sql.Open("sqlite3", "./pw-history.db")
	// if err != nil {
	// 	logger.Error("Error opening sqlite db", slog.Any("error", err))
	// 	os.Exit(3)
	// }
	// client := fleetapi.NewFleetApiClient(token, logger)
	// sod := time.Date(2024, 4, 29, 0, 0, 0, 0, time.Local)
	// err = loadSiteHistoryDay(db, sod, siteid, client)

	loadFullSiteHistory(siteid, token, logger)

	// today := time.Now()
	// siteId := os.Args[1]
	// start := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())
	// end := time.Date(today.Year(), today.Month(), today.Day(), 23, 59, 59, 9999, today.Location())

	// client := fleetapi.NewFleetApiClient(token, logger)
	// results, err := client.GetEnergyHistory(siteId, start, end, fleetapi.HistoryPeriod_Day, time.Local)
	// if err != nil {
	// 	logger.Error("Error getting energy history", slog.Any("error", err))
	// 	os.Exit(5)
	// }
	// // Calculate the mean
	// var sum float64
	// for _, ts := range results {
	// 	sum += ts.TotalHomeUsage
	// }
	// mean := sum / float64(len(results))

	// // Calculate the variance
	// var variance float64
	// for _, ts := range results {
	// 	difference := ts.TotalHomeUsage - mean
	// 	squaredDifference := difference * difference
	// 	variance += squaredDifference
	// }
	// variance = variance / float64(len(results))

	// // Calculate the standard deviation
	// stdDev := math.Sqrt(variance)

	// fmt.Printf("Data from %s to %s\n", start, end)
	// fmt.Printf("Mean: %.2f\n", mean)
	// fmt.Printf("StdDev: %.2f\n", stdDev)

}

func loadFullSiteHistory(siteid string, token string, logger *slog.Logger) error {
	client := fleetapi.NewFleetApiClient(token, logger)

	info, err := client.GetEnergySiteInfo(siteid)
	if err != nil {
		return fmt.Errorf("error getting energy site info: %w", err)
	}
	installed := info.InstallationDate
	location, err := time.LoadLocation(info.InstallationTimeZone)
	if err != nil {
		return fmt.Errorf("error loading site tz location: %w", err)
	}
	logger.Debug("site info", slog.String("siteid", siteid), slog.String("installed", installed.String()), slog.String("location", location.String()))

	start := time.Date(installed.Year(), installed.Month(), installed.Day(), 0, 0, 0, 0, location)
	end := time.Now().In(location)
	db_file := "./pw-history.db"
	os.Remove(db_file)
	db, err := sql.Open("sqlite3", db_file)
	if err != nil {
		return fmt.Errorf("error opening sqllite db file %s: %w", db_file, err)
	}

	_, err = db.Exec(`CREATE TABLE EnergyData (
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

	defer db.Close()
	for _, sod := range dateRange(start, end) {
		logger.Debug("loading history", slog.String("date", sod.Format("2006-01-02")))
		err := loadSiteHistoryDay(db, sod, siteid, client)
		if err != nil {
			return fmt.Errorf("error loading site history for date %s: %w", sod.Format("2006-01-02"), err)
		}
	}

	return nil
}

func loadSiteHistoryDay(db *sql.DB, sod time.Time, siteid string, client fleetapi.FleetApiClient) error {

	err := deleteDay(db, sod)
	if err != nil {
		return fmt.Errorf("error deleting day for date %s: %w", sod.Format("2006-01-02"), err)
	}

	eod := time.Date(sod.Year(), sod.Month(), sod.Day(), 23, 59, 59, 9999, sod.Location())
	results, err := client.GetEnergyHistory(siteid, sod, eod, fleetapi.HistoryPeriod_Day, sod.Location())
	if err != nil {
		return fmt.Errorf("error getting energy history for date %s: %w", sod.Format("2006-01-02"), err)
	}
	err = insertResults(db, results)
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

func insertResults(db *sql.DB, histories []fleetapi.EnergyHistoryEntry) error {
	stmt, err := db.Prepare(`INSERT INTO EnergyData(timestamp, load_power, solar_power, grid_power, battery_power) VALUES (?, ?, ?, ?, ?)`)
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

		_, err := stmt.Exec(h.Timestamp, h.TotalHomeUsage, h.SolarEnergyExported, grid, battery)
		if err != nil {
			return err
		}
	}

	return nil
}
