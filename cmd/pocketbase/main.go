// main.go
package main

import (
	"log"
	"os"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/robfig/cron"

	// uncomment once you have at least one .go migration file in the "migrations" directory
	_ "github.com/kevm/pw-usage/cmd/pocketbase/migrations"
)

func main() {
	app := pocketbase.New()
	sampler := NewSampler(app)

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
		scheduler.Start()
		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
