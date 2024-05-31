package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/kevm/pw-usage/internal/auth"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/kevm/pw-usage/internal/tui"
	"github.com/neomantra/ymdflag"
	"github.com/spf13/cobra"
)

var (
	version string
	commit  string
	date    string
	weburl  string
)

func main() {
	c, err := config.NewConfig(weburl)
	if err != nil {
		if errors.Is(err, &config.NoAuthTokenError{}) && os.Args[0] != "login" {
			c.Logger.Warn("no auth token found. Forcing authentication")
			cmdLogin(c).Run(cmdLogin(c), []string{})
		}
		c.Logger.Error("error creating config", slog.Any("error", err))
		os.Exit(-1)
	}
	c.Logger.Info("Starting pwrtool cli", slog.String("version", version), slog.String("commit", commit), slog.String("date", date))

	defer c.Database.Close()
	var rootCmd = &cobra.Command{Use: "pw-usage"}
	if c.Client != nil {
		rootCmd.AddCommand(cmdImport(c))
		rootCmd.AddCommand(cmdImportDay(c))
		rootCmd.AddCommand(usageCmd(c))
		rootCmd.AddCommand(cmdBatteryStartHold(c))
		rootCmd.AddCommand(cmdBatteryStopHold(c))
		rootCmd.AddCommand(cmdProducts(c))
		rootCmd.AddCommand(cmdAnalysis(c))
		rootCmd.AddCommand(cmdTea(c))
	}
	rootCmd.AddCommand(cmdLogin(c))
	// rootCmd.AddCommand(cmdRevoke(c))
	rootCmd.Execute()
}

func cmdTea(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "tui",
		Short: "interactive terminal UI",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			m := tui.NewModel(&c)
			p := tea.NewProgram(m, tea.WithAltScreen())
			if _, err := p.Run(); err != nil {
				fmt.Printf("Oops: %v", err)
				os.Exit(1)
			}
		},
	}
}

func usageCmd(c config.Config) *cobra.Command {
	return &cobra.Command{
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
				c.Logger.Error("error parsing date should be YYYYMMDD", slog.String("date", sd), slog.Any("error", err))
				os.Exit(1)
			}

			er := fleetdb.NewEnergyRepo(c.Database, c.Logger)
			site, err := er.LoadSite(siteid, c.Client)
			if err != nil {
				c.Logger.Error("Error loading site info", slog.Any("error", err))
				os.Exit(3)
			}

			start, end := fleetdb.GetDateRange(date_range, ymdStart.AsTime())

			usage := fleetdb.NewUsage(site, c.Database, c.Client, c.Logger)
			result, err := usage.GetEnergyUsage(start, end)
			if err != nil {
				c.Logger.Error("Error getting energy usage", slog.Any("error", err))
				os.Exit(4)
			}

			for _, r := range result {
				c.Logger.Info("Energy Usage", slog.Any("result", r))
			}
		},
	}
}

func cmdImport(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "import [siteid]",
		Short: "import site energy history into sqlite db",
		Args:  cobra.MinimumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			siteid := args[0]

			repo := fleetdb.NewEnergyRepo(c.Database, c.Logger)
			site, err := repo.LoadSite(siteid, c.Client)
			if err != nil {
				c.Logger.Error("Error loading site info", slog.Any("error", err))
				os.Exit(3)
			}

			importer := fleetdb.NewImporter(c.Database, c.Client, c.Logger)
			err = importer.LoadSiteEnergyData(site)
			if err != nil {
				c.Logger.Error("Error loading site history", slog.Any("error", err))
				os.Exit(4)
			}
		},
	}
}

func cmdImportDay(c config.Config) *cobra.Command {
	return &cobra.Command{
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
					c.Logger.Error("error parsing date should be YYYYMMDD", slog.String("date", ds), slog.Any("error", err))
					os.Exit(1)
				}
			}

			repo := fleetdb.NewEnergyRepo(c.Database, c.Logger)
			site, err := repo.LoadSite(siteid, c.Client)
			if err != nil {
				c.Logger.Error("Error loading site info", slog.Any("error", err))
				os.Exit(3)
			}

			importer := fleetdb.NewImporter(c.Database, c.Client, c.Logger)
			err = importer.LoadSiteEnergyDataForDay(d.AsTime(), site)
			if err != nil {
				c.Logger.Error("Error loading site history day", slog.Any("error", err))
				os.Exit(4)
			}

			c.Logger.Info("imported site history day", slog.String("date", ds), slog.String("siteid", siteid))
		},
	}
}

func cmdBatteryStartHold(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "battery-hold [siteid]",
		Short: "hold the battery the current level - usually used while charging vehicles",
		Args:  cobra.MinimumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			siteid := args[0]
			batteryReserve := fleetdb.NewBatteryHold(c.Database, c.Client, c.Logger)
			_, err := batteryReserve.StartHold(siteid)
			if err != nil {
				c.Logger.Error("Error holding battery", slog.Any("error", err))
				os.Exit(2)
			}
		},
	}
}

func cmdBatteryStopHold(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "battery-hold-done [siteid]",
		Short: "stop holding the battery level - used when done charging vehicles",
		Args:  cobra.MinimumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			siteid := args[0]
			batteryReserve := fleetdb.NewBatteryHold(c.Database, c.Client, c.Logger)
			err := batteryReserve.StopHold(siteid)
			if err != nil {
				c.Logger.Error("Error stopping battery hold", slog.Any("error", err))
				os.Exit(2)
			}
		},
	}
}

func cmdProducts(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "products",
		Short: "get list of products (sites) available to the account",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			products, err := c.Client.GetProducts()
			if err != nil {
				c.Logger.Error("Error getting products", slog.Any("error", err))
				os.Exit(1)
			}

			for _, p := range products {
				c.Logger.Info("product", slog.String("name", p.SiteName), slog.Int64("energy_site_id", p.EnergySiteID))
			}
		},
	}
}

func cmdLogin(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "login to the tesla api",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			c.Logger.Info("Login to the Tesla API")
			config, err := auth.NewLoginAuthConfig(weburl, c.Logger)
			if err != nil {
				c.Logger.Error("error creating auth config", slog.Any("error", err))
				os.Exit(1)
			}

			ch := auth.NewOAuthAction(config)
			err = <-ch
			if err != nil {
				c.Logger.Error("Error logging in", slog.Any("error", err))
				os.Exit(2)
			}
		},
	}
}

// func cmdRevoke(c config.Config) *cobra.Command {
// 	return &cobra.Command{
// 		Use:   "revoke-access",
// 		Short: "change or revoke access to the tesla api",
// 		Args:  cobra.NoArgs,
// 		Run: func(cmd *cobra.Command, args []string) {
// 			c.Logger.Info("Change or revoke Tesla API access")
// 			config, err := auth.NewRevokeAuthConfig(c.Logger)
// 			if err != nil {
// 				c.Logger.Error("error creating auth config", slog.Any("error", err))
// 				os.Exit(1)
// 			}

// 			ch := auth.NewOAuthAction(config)
// 			err = <-ch
// 			if err != nil {
// 				c.Logger.Error("Error revoking tesla api access", slog.Any("error", err))
// 				os.Exit(2)
// 			}
// 		},
// 	}
// }

func cmdAnalysis(c config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "analysis [siteid] [billing start date - YYYYMMDD]",
		Short: "hmm",
		Args:  cobra.MinimumNArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			siteid := args[0]
			er := fleetdb.NewEnergyRepo(c.Database, c.Logger)
			site, err := er.LoadSite(siteid, c.Client)
			if err != nil {
				c.Logger.Error("Error loading site info", slog.String("site", "siteid"), slog.Any("error", err))
				os.Exit(3)
			}

			bd := args[1]
			billingStart := ymdflag.YMDFlag{}
			err = billingStart.Set(bd)
			if err != nil {
				c.Logger.Error("error parsing billing date should be YYYYMMDD", slog.String("billing-date", bd), slog.Any("error", err))
				os.Exit(1)
			}

			importer := fleetdb.NewImporter(c.Database, c.Client, c.Logger)
			err = importer.LoadSiteEnergyData(site)
			if err != nil {
				c.Logger.Error("Error loading site history", slog.Any("error", err))
				os.Exit(4)
			}

			start, end := fleetdb.GetDateRange(fleetdb.BillingRange, billingStart.AsTimeWithLoc(site.Location))
			usage := fleetdb.NewUsage(site, c.Database, c.Client, c.Logger)
			result, err := usage.GetEnergyUsage(start, end)
			if err != nil {
				c.Logger.Error("Error getting energy usage", slog.Any("error", err))
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
					c.Logger.Error("Error getting tariff for result - skipping", slog.String("tariff", r.Tariff.Name))
					continue
				}
				t.HomeUsage += r.HomeUsage
				t.SolarProduction += r.SolarProduction
				t.GridUsage += r.GridUsage
				tariffMap[r.Tariff.Name] = t
			}

			fmt.Printf("\nTime of Use Report\n- for billing period %s to %s\n", start.Format("2006-01-02"), end.Format("2006-01-02"))
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
