package main

import (
	"fmt"
	"log/slog"
	"math"
	"os"
	"time"

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
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	var token string = ""
	if os.Getenv("FLEET_AUTH_TOKEN") != "" {
		token = os.Getenv("FLEET_AUTH_TOKEN")
	} else {
		logger.Error("Please set the FLEET_AUTH_TOKEN environment variable")
		os.Exit(1)
	}

	if len(os.Args) < 2 {
		logger.Error("Please provide a file name as the first argument")
		os.Exit(2)
	}

	today := time.Now()
	siteId := os.Args[1]
	start := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())
	end := time.Date(today.Year(), today.Month(), today.Day(), 23, 59, 59, 9999, today.Location())

	client := fleetapi.NewFleetApiClient(token, logger)
	results, err := client.GetEnergyHistory(siteId, start, end, fleetapi.HistoryPeriod_Day, time.Local)
	if err != nil {
		logger.Error("Error getting energy history", slog.Any("error", err))
		os.Exit(5)
	}
	// Calculate the mean
	var sum float64
	for _, ts := range results {
		sum += ts.TotalHomeUsage
	}
	mean := sum / float64(len(results))

	// Calculate the variance
	var variance float64
	for _, ts := range results {
		difference := ts.TotalHomeUsage - mean
		squaredDifference := difference * difference
		variance += squaredDifference
	}
	variance = variance / float64(len(results))

	// Calculate the standard deviation
	stdDev := math.Sqrt(variance)

	fmt.Printf("Data from %s to %s\n", start, end)
	fmt.Printf("Mean: %.2f\n", mean)
	fmt.Printf("StdDev: %.2f\n", stdDev)
}
