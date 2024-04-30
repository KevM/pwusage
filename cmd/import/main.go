package main

import (
	"log/slog"
	"math"
	"os"

	"github.com/joho/godotenv"
	_ "github.com/mattn/go-sqlite3"

	"github.com/neomantra/ymdflag"
	"github.com/spf13/cobra"
)

var db *Database
var db_file = "./pw-history.db"
var logger *slog.Logger
var token string

func init() {
	godotenv.Load()
	logger = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	if os.Getenv("FLEET_AUTH_TOKEN") != "" {
		token = os.Getenv("FLEET_AUTH_TOKEN")
	} else {
		logger.Error("Please set the FLEET_AUTH_TOKEN environment variable")
		os.Exit(1)
	}

	d, err := NewDatabase(db_file)
	if err != nil {
		logger.Error("Error opening database", slog.Any("error", err))
		os.Exit(2)
	}
	db = d
}

func main() {
	var rootCmd = &cobra.Command{Use: "pw-usage"}
	rootCmd.PersistentFlags().StringVarP(&db_file, "db", "d", db_file, "sqlite db file")
	rootCmd.PersistentFlags().StringVarP(&token, "token", "t", token, "tesla fleet api token")
	rootCmd.AddCommand(cmdImport)
	rootCmd.AddCommand(cmdImportDay)
	rootCmd.AddCommand(cmdUsage)
	rootCmd.Execute()
}

var cmdUsage = &cobra.Command{
	Use:   "usage-day [YYYYMMDD]",
	Short: "determine energy usage for the given date",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		sd := args[0]
		d := ymdflag.YMDFlag{}
		err := d.Set(sd)
		if err != nil {
			logger.Error("error parsing date should be YYYYMMDD", slog.String("date", sd), slog.Any("error", err))
			os.Exit(1)
		}

		repo := NewEnergyRepo(db)
		data, err := repo.GetEnergies(d.AsTime(), d.AsTime().AddDate(0, 0, 1))
		if err != nil {
			logger.Error("error getting energies", slog.Any("error", err))
			os.Exit(5)
		}

		var load_sum, solar_sum, grid_sum float64
		for _, e := range data {
			load_sum += e.LoadPower
			solar_sum += e.SolarPower
			grid_sum += e.GridPower
		}

		len := float64(len(data))
		load_mean := load_sum / len
		// Calculate the variance
		var variance float64
		for _, ts := range data {
			difference := ts.LoadPower - load_mean
			squaredDifference := difference * difference
			variance += squaredDifference
		}
		variance = variance / len

		// Calculate the standard deviation
		stdDev := math.Sqrt(variance)

		logger.Info("energy usage", slog.String("date", d.AsTime().Format("2006-01-02")), slog.Float64("usage", load_sum), slog.Float64("load-stddev", stdDev), slog.Float64("solar", solar_sum), slog.Float64("grid", grid_sum))
	},
}

var cmdImport = &cobra.Command{
	Use:   "import [siteid]",
	Short: "import site energy history into sqlite db",
	Args:  cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		siteid := args[0]
		importer := NewImporter(token, db_file, logger)

		err := importer.LoadFullSiteHistory(db, siteid)
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

		importer := NewImporter(token, db_file, logger)
		err := importer.LoadSiteHistoryDay(db, d.AsTime(), siteid)
		if err != nil {
			logger.Error("Error loading site history day", slog.Any("error", err))
			os.Exit(4)
		}

		logger.Info("imported site history day", slog.String("date", ds), slog.String("siteid", siteid))
	},
}
