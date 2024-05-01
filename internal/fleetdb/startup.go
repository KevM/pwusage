package fleetdb

// import (
// 	"log/slog"
// 	"os"

// 	"github.com/joho/godotenv"

// 	"github.com/kevm/pw-usage/internal/auth"
// 	"github.com/kevm/pw-usage/internal/fleetapi"
// 	_ "github.com/mattn/go-sqlite3"
// )

// func Setup(db_file string) (*Database, *fleetapi.Client, *slog.Logger, error) {
// 	godotenv.Load()
// 	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
// 		Level: slog.LevelDebug,
// 	}))

// 	authCfg, err := auth.NewAuthConfig()
// 	if err != nil {
// 		return nil, nil, logger, err
// 	}

// 	dotfiles := authCfg.LoadDotFiles(logger)

// 	var authToken string
// 	if dotfiles.Error != nil {
// 		logger.Error("error loading dotfiles", slog.Any("error", dotfiles.Error))
// 		authToken = os.Getenv("TESLA_AUTH_TOKEN")
// 		if authToken == "" {
// 			logger.Error("no auth token found in environment")
// 			os.Exit(1)
// 		}
// 	} else {
// 		logger.Debug("loaded auth tokens from dotfiles")
// 		authToken = dotfiles.AccessToken
// 	}

// 	client := fleetapi.NewFleetApiClient(authToken, logger)

// 	db, err := NewDatabase(db_file)
// 	if err != nil {
// 		return nil, client, logger, err
// 	}

// 	return db, client, logger, nil
// }
