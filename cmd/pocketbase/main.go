// main.go
package main

import (
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/joho/godotenv"
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
	godotenv.Load()

	tz := "America/Chicago"
	if os.Getenv("TZ") != "" {
		tz = os.Getenv("TZ")
	}
	web_dir := "/Users/kevm/github/pwusage/cmd/web-static/build"
	if os.Getenv("WEB_DIR") != "" {
		web_dir = os.Getenv("WEB_DIR")
	}
	err := replacePublicEnvironmentVariablesInFile(filepath.Join(web_dir, "_app/env.js"))
	if err != nil {
		panic(fmt.Errorf("error replacing public environment variables in file: %w", err))
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

		e.Router.GET("/usage/api/backfill", func(c echo.Context) error {
			startS := c.QueryParam("start")
			endS := c.QueryParam("end")
			gaplimit := 61 * time.Minute

			start, end, err := monitor.VerifyDateRange(startS, endS)
			if err != nil {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			sr := monitor.NewSampleRepo(app)
			backfills, err := sr.GetSampleGaps(start, end, gaplimit)
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			// range through gaps and get data from fleetapi and transform them into samples saving as we go in a transaction

			return c.JSON(http.StatusOK, backfills)
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

		// look for file in "{web_dir}/_app/env.js" and replace all instances of "PUBLIC_*" with the corresponding environment variable

		e.Router.GET("/usage/*", apis.StaticDirectoryHandler(os.DirFS(web_dir), false))

		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func publicEnvVars() map[string]string {
	envVars := make(map[string]string)

	for _, env := range os.Environ() {
		if strings.HasPrefix(env, "PUBLIC_") {
			pair := strings.SplitN(env, "=", 2)
			envVars[pair[0]] = pair[1]
		}
	}

	return envVars
}

func replacePublicEnvironmentVariablesInFile(filePath string) error {
	// Read the file
	content, err := os.ReadFile(filePath)
	if err != nil {
		log.Printf("No replacement file %s found, skipping replacement", filePath)
		return nil
	}
	contentString := string(content)

	pev := publicEnvVars()

	if len(pev) < 1 {
		log.Println("No PUBLIC_* environment variables found, skipping replacement in env.js")
		return nil
	}

	for k, v := range pev {
		rstr := fmt.Sprintf(`"%s":"[^"]*"`, k)
		re := regexp.MustCompile(rstr)

		log.Printf("Replacing env.js key %s with value %s", k, v)
		// Replace the matched substring with the new value
		contentString = re.ReplaceAllString(contentString, `"`+k+`":"`+v+`"`)
	}

	log.Printf("env.js content after replacement:\n%s", contentString)

	// Write the modified content back to the file
	err = os.WriteFile(filePath, []byte(contentString), 0644)
	if err != nil {
		return err
	}

	return nil
}
