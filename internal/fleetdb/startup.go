package fleetdb

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/joho/godotenv"

	"github.com/kevm/pw-usage/internal/fleetapi"
	_ "github.com/mattn/go-sqlite3"
)

func Setup(db_file string) (*Database, *fleetapi.Client, *slog.Logger, error) {
	godotenv.Load()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	token := os.Getenv("FLEET_AUTH_TOKEN")
	if token == "" {
		return nil, nil, logger, fmt.Errorf("missing FLEET_AUTH_TOKEN")
	}
	client := fleetapi.NewFleetApiClient(token, logger)

	db, err := NewDatabase(db_file)
	if err != nil {
		return nil, client, logger, err
	}

	return db, client, logger, nil
}
