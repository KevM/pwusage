package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

// Sampler is `Run` as a cron job to sample the Powerwall API and save the results to the database
// When the date or tariff changes, a usage record is created and saved to the database
type Sampler struct {
	api      *monitor.PowerwallApi
	pb       *pocketbase.PocketBase
	schedule monitor.Schedule
}

func NewSampler(pb *pocketbase.PocketBase, s monitor.Schedule) *Sampler {
	baseUri := "http://localhost:8675"
	if envBaseUri := os.Getenv("PYPOWERWALL_BASE_URI"); envBaseUri != "" {
		baseUri = envBaseUri // use environment variable value if it's set
	}

	api := monitor.NewPowerwallApi(baseUri, pb.Logger())
	return &Sampler{
		pb:       pb,
		api:      api,
		schedule: s,
	}
}

func (s *Sampler) Run() {
	now := s.schedule.Now()
	s.CreateSample(now)
}

func (s *Sampler) CreateSample(t time.Time) {
	pwapi, err := s.api.GetPwApi()
	if err != nil {
		s.pb.Logger().Error("sampler: error getting Powerwall API", slog.Any("error", err))
	}

	// save sample
	dao := s.pb.Dao()
	collection, err := dao.FindCollectionByNameOrId("sample")
	if err != nil {
		s.pb.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	tp := s.schedule.GetTariffPeriod(t)

	// sample record
	sr := models.NewRecord(collection)
	sr.Set("tariff", tp.Tariff)
	sr.Set("home_usage", pwapi.Aggregates.Load.EnergyImported)
	sr.Set("solar_production", pwapi.Aggregates.Solar.EnergyExported)
	sr.Set("grid_imported", pwapi.Aggregates.Site.EnergyImported)
	sr.Set("grid_exported", pwapi.Aggregates.Site.EnergyExported)
	sr.Set("battery_charge", pwapi.Csv.SOC)
	sr.Set("current_battery_usage", pwapi.Csv.Battery)
	sr.Set("current_home_usage", pwapi.Csv.Home)
	sr.Set("current_solar_usage", pwapi.Csv.Solar)
	sr.Set("current_grid_usage", pwapi.Csv.Grid)

	if err := dao.SaveRecord(sr); err != nil {
		s.pb.Logger().Error("Sampler: error saving sample record to collection", slog.Any("error", err))
	}
}
