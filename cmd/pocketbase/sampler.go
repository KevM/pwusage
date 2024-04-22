package main

import (
	"fmt"
	"log/slog"
	"os"

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
	s.pb.Logger().Debug("sample/usage update job", slog.Any("time", now))

	tp := s.schedule.GetTariffPeriod(now)

	_, err := s.CreateSample(tp)
	if err != nil {
		s.pb.Logger().Error("sample: error creating sample", slog.Any("error", err))
		return
	}

	_, err = s.UpsertUsage(tp)
	if err != nil {
		s.pb.Logger().Error("usager: error generating usage report", slog.Any("error", err))
		return
	}
}

func (s *Sampler) CreateSample(tp monitor.TariffPeriod) (*models.Record, error) {
	pwapi, err := s.api.GetPwApi()
	if err != nil {
		return nil, fmt.Errorf("sample: error getting Powerwall API: %w", err)
	}

	// save sample
	dao := s.pb.Dao()
	collection, err := dao.FindCollectionByNameOrId("sample")
	if err != nil {
		return nil, fmt.Errorf("sample: error finding collection: %w", err)
	}

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
		return sr, fmt.Errorf("sample: error saving sample record: %w", err)
	}

	return sr, nil
}

func (s *Sampler) UpsertUsage(tp monitor.TariffPeriod) (*models.Record, error) {
	repo := monitor.NewUsageRepo(s.pb)
	ur, err := repo.GetTariffPeriodUsages(tp)
	if err != nil {
		return nil, fmt.Errorf("error getting to maybe upsertL %w", err)
	}

	sr := monitor.NewSampleRepo(s.pb)
	start, end, err := sr.GetTarrifPeriodStartAndEndSamples(tp)
	if err != nil {
		return nil, fmt.Errorf("error getting start and end usage samples: %w", err)
	}

	ur = repo.CreateUsageRecord(ur, tp, start, end)
	if err := s.pb.Dao().SaveRecord(ur); err != nil {
		return nil, fmt.Errorf("error saving usage record: %w", err)
	}

	return ur, nil
}
