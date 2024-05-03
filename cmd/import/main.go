package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/neomantra/ymdflag"
	"github.com/spf13/cobra"
)

var db *fleetdb.Database
var db_file = "./pw-history.db"
var logger *slog.Logger
var client *fleetapi.Client

func init() {
	var err error
	db, client, logger, err = fleetdb.Setup(db_file)
	if err != nil {
		logger.Error("error setting up db", slog.Any("error", err))
		os.Exit(1)
	}
}

func main() {
	defer db.Close()
	var rootCmd = &cobra.Command{Use: "pw-usage"}
	rootCmd.AddCommand(cmdImport)
	rootCmd.AddCommand(cmdImportDay)
	rootCmd.AddCommand(cmdUsage)
	rootCmd.AddCommand(cmdBatteryStartHold)
	rootCmd.AddCommand(cmdBatteryStopHold)
	rootCmd.AddCommand(cmdProducts)
	rootCmd.AddCommand(cmdAnalysis)
	rootCmd.Execute()
}

var cmdUsage = &cobra.Command{
	Use:   "usage [siteid] [day|week|month|year] [YYYYMMDD]",
	Short: "determine energy usage for the given date",
	Args:  cobra.MinimumNArgs(3),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		date_range := args[1]
		sd := args[2]

		ymdStart := ymdflag.YMDFlag{}
		err := ymdStart.Set(sd)
		if err != nil {
			logger.Error("error parsing date should be YYYYMMDD", slog.String("date", sd), slog.Any("error", err))
			os.Exit(1)
		}

		er := fleetdb.NewEnergyRepo(db, logger)
		site, err := er.LoadSite(siteid, client)
		if err != nil {
			logger.Error("Error loading site info", slog.Any("error", err))
			os.Exit(3)
		}

		start, end := fleetdb.GetDateRange(date_range, ymdStart.AsTime())

		usage := fleetdb.NewUsage(site, db, client, logger)
		result, err := usage.GetEnergyUsage(start, end)
		if err != nil {
			logger.Error("Error getting energy usage", slog.Any("error", err))
			os.Exit(4)
		}

		for _, r := range result {
			logger.Info("Energy Usage", slog.Any("result", r))
		}
	},
}

var cmdImport = &cobra.Command{
	Use:   "import [siteid]",
	Short: "import site energy history into sqlite db",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]

		repo := fleetdb.NewEnergyRepo(db, logger)
		site, err := repo.LoadSite(siteid, client)
		if err != nil {
			logger.Error("Error loading site info", slog.Any("error", err))
			os.Exit(3)
		}

		importer := fleetdb.NewImporter(db, client, logger)
		err = importer.LoadSiteEnergyData(site)
		if err != nil {
			logger.Error("Error loading site history", slog.Any("error", err))
			os.Exit(4)
		}
	},
}

var cmdImportDay = &cobra.Command{
	Use:   "import-day [siteid] [date]",
	Short: "import site energy history for a specific day YYYYMMDD into sqlite db",
	Args:  cobra.MinimumNArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		ds := args[1]

		d := ymdflag.YMDFlag{}
		if ds != "" {
			err := d.Set(ds)
			if err != nil {
				logger.Error("error parsing date should be YYYYMMDD", slog.String("date", ds), slog.Any("error", err))
				os.Exit(1)
			}
		}

		repo := fleetdb.NewEnergyRepo(db, logger)
		site, err := repo.LoadSite(siteid, client)
		if err != nil {
			logger.Error("Error loading site info", slog.Any("error", err))
			os.Exit(3)
		}

		importer := fleetdb.NewImporter(db, client, logger)
		err = importer.LoadSiteEnergyDataForDay(d.AsTime(), site)
		if err != nil {
			logger.Error("Error loading site history day", slog.Any("error", err))
			os.Exit(4)
		}

		logger.Info("imported site history day", slog.String("date", ds), slog.String("siteid", siteid))
	},
}

var cmdBatteryStartHold = &cobra.Command{
	Use:   "battery-hold [siteid]",
	Short: "hold the battery the current level - usually used while charging vehicles",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		batteryReserve := fleetdb.NewBatteryHold(db, client, logger)
		err := batteryReserve.StartHold(siteid)
		if err != nil {
			logger.Error("Error holding battery", slog.Any("error", err))
			os.Exit(2)
		}
	},
}

var cmdBatteryStopHold = &cobra.Command{
	Use:   "battery-hold-done [siteid]",
	Short: "stop holding the battery level - used when done charging vehicles",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		batteryReserve := fleetdb.NewBatteryHold(db, client, logger)
		err := batteryReserve.StopHold(siteid)
		if err != nil {
			logger.Error("Error stopping battery hold", slog.Any("error", err))
			os.Exit(2)
		}
	},
}

var cmdProducts = &cobra.Command{
	Use:   "products",
	Short: "get list of products (sites) available to the account",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		products, err := client.GetProducts()
		if err != nil {
			logger.Error("Error getting products", slog.Any("error", err))
			os.Exit(1)
		}

		for _, p := range products {
			logger.Info("product", slog.String("name", p.SiteName), slog.Int64("energy_site_id", p.EnergySiteID))
		}
	},
}

var cmdAnalysis = &cobra.Command{
	Use:   "analysis [siteid]",
	Short: "hmm",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		er := fleetdb.NewEnergyRepo(db, logger)
		site, err := er.LoadSite(siteid, client)
		if err != nil {
			logger.Error("Error loading site info", slog.String("site", "siteid"), slog.Any("error", err))
			os.Exit(3)
		}

		importer := fleetdb.NewImporter(db, client, logger)
		err = importer.LoadSiteEnergyData(site)
		if err != nil {
			logger.Error("Error loading site history", slog.Any("error", err))
			os.Exit(4)
		}

		start, end := fleetdb.GetDateRange(fleetdb.MonthRange, time.Now().In(site.Location))
		usage := fleetdb.NewUsage(site, db, client, logger)
		result, err := usage.GetEnergyUsage(start, end)
		if err != nil {
			logger.Error("Error getting energy usage", slog.Any("error", err))
			os.Exit(4)
		}

		type analysis struct {
			Tariff          *fleetdb.Tariff
			Season          *fleetdb.TariffSeason
			HomeUsage       float64
			GridUsage       float64
			SolarProduction float64
		}

		tariffMap := map[string]analysis{}
		for _, t := range site.Tariffs {
			season := t.FindSeason(start)
			tariffMap[t.Name] = analysis{
				Tariff: &t,
				Season: season,
			}
		}

		for _, r := range result {
			t, ok := tariffMap[r.Tariff.Name]
			if !ok {
				logger.Error("Error getting tariff for result - skipping", slog.String("tariff", r.Tariff.Name))
				continue
			}
			t.HomeUsage += r.HomeUsage
			t.SolarProduction += r.SolarProduction
			t.GridUsage += r.GridUsage
			tariffMap[r.Tariff.Name] = t
		}

		// show row for each tariff with home usage and solar production and how much it will cost
		for _, t := range tariffMap {
			usageLabel, cost := Cost(*t.Season, t.GridUsage)
			fmt.Printf("\nTariff: %s\n", t.Tariff.Name)
			fmt.Printf("Season: %s\t Buy Rate: %.2f\tSell Rate: %.2f\n", t.Season.Name, t.Season.BuyRate, t.Season.SellRate)
			fmt.Printf("Home Usage: %.2f kwh\n", kwh(t.HomeUsage))
			fmt.Printf("Grid Usage: %.2f kwh\t%s: %.2f\n", kwh(t.GridUsage), usageLabel, cost)
			fmt.Printf("Solar Production: %.2f kwh\n", kwh(t.SolarProduction))
		}
	},
}

func kwh(usage float64) float64 {
	return usage / 1000
}

// Cost returns the cost or credit for the given season and usage. First result is the label, Second is the cost/credit
func Cost(season fleetdb.TariffSeason, usage float64) (string, float64) {
	if usage > 0 {
		return "Cost", season.BuyRate * kwh(usage)
	}

	return "Credit", 0 - (season.SellRate * kwh(usage))
}
