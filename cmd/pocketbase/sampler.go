package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

// PwSnapshot is a snapshot of the Powerwall API results and tarrif point in time
type PwSnapshot struct {
	Time   time.Time
	Tariff string
	Sample *monitor.PwApi
}

// Sampler is `Run` as a cron job to sample the Powerwall API and save the results to the database
// When the date or tariff changes, a usage record is created and saved to the database
type Sampler struct {
	api        *monitor.PowerwallApi
	pocketbase *pocketbase.PocketBase
	Snapshot   *PwSnapshot
}

func NewSampler(pocketbase *pocketbase.PocketBase) *Sampler {
	baseUri := "http://localhost:8675"
	if envBaseUri := os.Getenv("PYPOWERWALL_BASE_URI"); envBaseUri != "" {
		baseUri = envBaseUri // use environment variable value if it's set
	}

	api := monitor.NewPowerwallApi(baseUri, pocketbase.Logger())
	return &Sampler{
		pocketbase: pocketbase,
		api:        api,
	}
}

func (s *Sampler) Run() {
	now := time.Now()
	tariff := s.activeTariff(now)

	pwapi, err := s.api.GetPwApi()
	if err != nil {
		s.pocketbase.Logger().Error("sampler: error getting Powerwall API", slog.Any("error", err))
	}

	if s.Snapshot == nil {
		snapshot := PwSnapshot{
			Time:   now,
			Tariff: tariff,
			Sample: &pwapi,
		}

		s.pocketbase.Logger().Info("setting sampler's snapshot as it is not set yet", slog.Any("snapshot", snapshot))
		s.Snapshot = &snapshot
	}

	// save sample
	dao := s.pocketbase.Dao()
	collection, err := dao.FindCollectionByNameOrId("sample")
	if err != nil {
		s.pocketbase.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	record := models.NewRecord(collection)
	record.Set("tariff", tariff)
	record.Set("home_usage", pwapi.Aggregates.Load.EnergyImported)
	record.Set("solar_production", pwapi.Aggregates.Solar.EnergyExported)
	record.Set("grid_imported", pwapi.Aggregates.Site.EnergyImported)
	record.Set("grid_exported", pwapi.Aggregates.Site.EnergyExported)
	record.Set("battery_charge", pwapi.Csv.SOC)
	record.Set("current_battery_usage", pwapi.Csv.Battery)
	record.Set("current_home_usage", pwapi.Csv.Home)
	record.Set("current_solar_usage", pwapi.Csv.Solar)
	record.Set("current_grid_usage", pwapi.Csv.Grid)

	if err := dao.SaveRecord(record); err != nil {
		s.pocketbase.Logger().Error("Sampler: error saving sample record to collection", slog.Any("error", err))
	}

	// create usage record when we cross a date or tariff boundary
	if now.Day() != s.Snapshot.Time.Day() || tariff != s.Snapshot.Tariff {
		s.pocketbase.Logger().Debug("crossed tarrif boundary", slog.Any("now", now), slog.Any("snapshot", s.Snapshot), slog.String("tariff", tariff))
		usage := s.createUsage(s.Snapshot.Sample, &pwapi)
		if err := dao.SaveRecord(usage); err != nil {
			s.pocketbase.Logger().Error("Sampler: error saving usage record to collection", slog.Any("error", err))
			return
		}

		newSnapshot := PwSnapshot{
			Time:   now,
			Tariff: tariff,
			Sample: &pwapi,
		}

		s.pocketbase.Logger().Info("updating sampler snapshot", slog.Any("snapshot", s.Snapshot))
		s.Snapshot = &newSnapshot
	}
}

func (s *Sampler) createUsage(start *monitor.PwApi, end *monitor.PwApi) *models.Record {
	s.pocketbase.Logger().Info("Creating usage record", slog.Any("start", start), slog.Any("end", end))

	dao := s.pocketbase.Dao()
	collection, err := dao.FindCollectionByNameOrId("usage")
	if err != nil {
		s.pocketbase.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	// calculate usage
	homeUsage := end.Aggregates.Load.EnergyImported - start.Aggregates.Load.EnergyImported
	solarProduction := end.Aggregates.Solar.EnergyExported - start.Aggregates.Solar.EnergyExported
	gridImported := end.Aggregates.Site.EnergyImported - start.Aggregates.Site.EnergyImported
	gridExported := end.Aggregates.Site.EnergyExported - start.Aggregates.Site.EnergyExported

	record := models.NewRecord(collection)
	record.Set("tariff", s.Snapshot.Tariff)
	record.Set("start", s.Snapshot.Time)
	record.Set("home_usage", homeUsage)
	record.Set("solar_production", solarProduction)
	record.Set("grid_imported", gridImported)
	record.Set("grid_exported", gridExported)

	return record
}

func (s *Sampler) activeTariff(now time.Time) string {
	// if weekend return "Off-Peak"
	if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday {
		return "Off-Peak"
	}

	// if between 8am and 8pm return "Peak"
	if now.Hour() >= 8 && now.Hour() < 20 {
		return "On-Peak"
	}

	return "Off-Peak"
}
