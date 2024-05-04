package config

import (
	"log/slog"
	"os"

	"github.com/kevm/pw-usage/internal/auth"
	"github.com/kevm/pw-usage/internal/fleetapi"
	"github.com/kevm/pw-usage/internal/fleetdb"

	"github.com/joho/godotenv"
)

type Config struct {
	Database *fleetdb.Database
	Client   *fleetapi.Client
	Logger   *slog.Logger
}

type NoAuthTokenError struct {
}

func (e *NoAuthTokenError) Error() string {
	return "no auth token found"
}

func NewConfig() (Config, error) {
	godotenv.Load()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	result := Config{
		Logger: logger,
	}

	authCfg, err := auth.NewAuthConfig()
	if err != nil {
		return result, err
	}

	dotfiles := authCfg.LoadDotFiles(logger)

	var authToken string
	if dotfiles.Error != nil {
		logger.Error("error loading dotfiles", slog.Any("error", dotfiles.Error))
		authToken = os.Getenv("TESLA_AUTH_TOKEN")
		if authToken == "" {
			return result, &NoAuthTokenError{}
		}
	} else {
		authToken = dotfiles.AccessToken
	}
	result.Client = fleetapi.NewFleetApiClient(authToken, logger)

	db, err := fleetdb.NewDatabase("./pwusage.db")
	if err != nil {
		return result, err
	}
	result.Database = db

	return result, nil
}
