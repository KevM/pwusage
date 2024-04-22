// main.go
package main

import (
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/robfig/cron"

	_ "github.com/kevm/pw-usage/cmd/pocketbase/migrations"
)

func main() {
	tz := "America/Chicago"
	if os.Getenv("TZ") != "" {
		tz = os.Getenv("TZ")
	}
	web_dir := "/Users/kevm/github/power/cmd/web/build"
	if os.Getenv("WEB_DIR") != "" {
		web_dir = os.Getenv("WEB_DIR")
	}

	location, err := time.LoadLocation(tz)
	if err != nil {
		panic(err)
	}

	var programLevel = new(slog.LevelVar)
	h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: programLevel})
	slog.SetDefault(slog.New(h))

	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDev: true})
	schedule := monitor.NewTimeOfUse(location)
	sampler := NewSampler(app, schedule)
	reporter := NewReporter(app, schedule, location)

	// loosely check if it was executed using "go run"
	isGoRun := strings.HasPrefix(os.Args[0], os.TempDir())

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		// enable auto creation of migration files when making collection changes in the Admin UI
		// (the isGoRun check is to enable it only during development)
		Automigrate: isGoRun,
	})

	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		scheduler := cron.New()
		scheduler.AddJob("*/60 * * * * *", sampler)
		scheduler.Start()

		e.Router.GET("/usage/api/report/:date-range", func(c echo.Context) error {
			dateRange := c.PathParam("date-range")
			startS := c.QueryParam("start")

			dateRange, start, err := monitor.VerifyRangeStart(dateRange, startS, schedule.Now())
			if err != nil {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			report, err := reporter.GetUsageReport(dateRange, start)
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			return c.JSON(http.StatusOK, report)
		})

		e.Router.GET("/usage/api/currently", func(c echo.Context) error {
			report, err := reporter.GetCurrentlyReport(schedule.Now())
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			return c.JSON(http.StatusOK, report)
		})

		e.Router.GET("/usage/api/dashboard", func(c echo.Context) error {
			report, err := reporter.GetDashboardReport(schedule.Now())
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			return c.JSON(http.StatusOK, report)
		})

		e.Router.GET("/usage/*", apis.StaticDirectoryHandler(os.DirFS(web_dir), false))

		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
