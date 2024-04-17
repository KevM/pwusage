// main.go
package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/robfig/cron"

	// uncomment once you have at least one .go migration file in the "migrations" directory
	_ "github.com/kevm/pw-usage/cmd/pocketbase/migrations"
)

func main() {
	tz := "America/Chicago"
	if os.Getenv("TZ") != "" {
		tz = os.Getenv("TZ")
	}

	location, err := time.LoadLocation(tz)
	if err != nil {
		panic(err)
	}

	app := pocketbase.New()
	tariffSchedule := monitor.NewTimeOfUse(location)
	sampler := NewSampler(app, tariffSchedule)
	usager := NewUsager(app, tariffSchedule)
	reporter := NewReporter(app, tariffSchedule, location)

	// loosely check if it was executed using "go run"
	isGoRun := strings.HasPrefix(os.Args[0], os.TempDir())

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		// enable auto creation of migration files when making collection changes in the Admin UI
		// (the isGoRun check is to enable it only during development)
		Automigrate: isGoRun,
	})

	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		scheduler := cron.New()
		scheduler.AddJob("*/30 * * * * *", sampler)
		scheduler.Schedule(tariffSchedule, usager)
		scheduler.Start()

		e.Router.GET("/usage/:date-range", func(c echo.Context) error {
			dateRange := c.PathParam("date-range")
			startS := c.QueryParam("start")
			if startS == "" {
				startS = time.Now().In(location).Format("20060102")
			}
			start, err := monitor.VerifyDate(startS)
			if err != nil {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			report, err := reporter.GetUsageReport(dateRange, start)
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			return c.JSON(http.StatusOK, report)
		})

		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
