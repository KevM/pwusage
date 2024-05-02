package main

import (
	"log/slog"
	"os"

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

		importer := fleetdb.NewImporter(client, logger)
		err = importer.LoadFullSiteHistory(db, site)
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

		importer := fleetdb.NewImporter(client, logger)
		err = importer.LoadSiteHistoryDay(db, d.AsTime(), site)
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

		client := fleetapi.NewFleetApiClient(token, logger)
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
