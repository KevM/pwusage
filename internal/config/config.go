package config

import (
	"fmt"
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

	Site         *fleetdb.Site
	BillStartDay int
}

type NoAuthTokenError struct {
}

func (e *NoAuthTokenError) Error() string {
	return "no auth token found"
}

func NewConfig() (Config, error) {
	godotenv.Load()

	logFile, err := os.OpenFile("pwusage.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		panic(err)
	}
	logger := slog.New(slog.NewTextHandler(logFile, &slog.HandlerOptions{Level: slog.LevelDebug}))
	result := Config{
		Logger: logger,
	}

	authCfg, err := auth.NewLoginAuthConfig(logger)
	if err != nil {
		return result, err
	}

	dotfiles := authCfg.LoadDotFiles(logger)

	var authToken string
	if dotfiles.Error != nil {
		logger.Warn("error loading saved configuration", slog.Any("error", dotfiles.Error))
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

	if dotfiles.Siteid != "" {
		er := fleetdb.NewEnergyRepo(db, logger)
		result.Site, err = er.LoadSite(dotfiles.Siteid, result.Client)
		if err != nil {
			logger.Warn("error loading site info - skipping", slog.String("site_id", dotfiles.Siteid), slog.Any("error", err))
		}
	}

	result.BillStartDay = dotfiles.BillStartDay

	return result, nil
}

func (c Config) SaveToDotFiles() error {
	authCfg, err := auth.NewLoginAuthConfig(c.Logger)
	if err != nil {
		return err
	}

	dotfiles := authCfg.LoadDotFiles(c.Logger)
	if dotfiles.Error != nil {
		return fmt.Errorf("could not load dot files for saving: %w", dotfiles.Error)
	}

	dotfiles.BillStartDay = c.BillStartDay
	if c.Site != nil {
		dotfiles.Siteid = c.Site.Id
	}

	return dotfiles.WriteToDotFiles()
}
