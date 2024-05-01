package fleetdb

import (
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Usage struct {
	siteid   string
	client   *fleetapi.Client
	schedule *Schedule
	db       *Database
	logger   *slog.Logger
}

func NewUsage(siteid string, db *Database, client *fleetapi.Client, logger *slog.Logger) (*Usage, error) {
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

type UsageData struct {
	Siteid          string
	Start           time.Time
	End             time.Time
	GridExported    float64
	GridImported    float64
	SolarProduction float64
	BatteryChange   float64
	HomeUsage       float64
}

func (u *Usage) GetUsage(siteid string, data []EnergyData) error {
	return nil
	// var usage int
	// err := u.db.QueryRow("SELECT usage FROM Usage WHERE site_id = ?", siteid).Scan(&usage)
	// if err != nil {
	// 	if err == sql.ErrNoRows {
	// 		return fmt.Errorf("no usage record found for siteid: %s", siteid)
	// 	}
	// 	return fmt.Errorf("error querying usage record: %w", err)
	// }

	// u.logger.Debug("Usage state", slog.Int("usage", usage))
}
