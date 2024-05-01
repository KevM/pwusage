package main

import (
	"log/slog"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Usage struct {
	siteid   string
	client   *fleetapi.FleetApiClient
	schedule *Schedule
	db       *Database
	logger   *slog.Logger
}

func NewUsage(siteid string, db *Database, token string, logger *slog.Logger) (*Usage, error) {
	client := fleetapi.NewFleetApiClient(token, logger)
	repo := NewEnergyRepo(db, logger)
	site, err := repo.LoadSite(siteid, client)
	if err != nil {
		return nil, err
	}

	schedule := NewSchedule(site.Tariffs)

	return &Usage{
		siteid:   siteid,
		schedule: schedule,
		client:   client,
		db:       db,
		logger:   logger,
	}, nil
}

// func (u *Usage) GetUsage(siteid string, ) error {
// 	var usage int
// 	err := u.db.QueryRow("SELECT usage FROM Usage WHERE site_id = ?", siteid).Scan(&usage)
// 	if err != nil {
// 		if err == sql.ErrNoRows {
// 			return fmt.Errorf("no usage record found for siteid: %s", siteid)
// 		}
// 		return fmt.Errorf("error querying usage record: %w", err)
// 	}

// 	u.logger.Debug("Usage state", slog.Int("usage", usage))
// }
