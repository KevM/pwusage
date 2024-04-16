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
	api        *monitor.PowerwallApi
	pocketbase *pocketbase.PocketBase
	schedule   monitor.Schedule
}

func NewSampler(pb *pocketbase.PocketBase, s monitor.Schedule) *Sampler {
	baseUri := "http://localhost:8675"
	if envBaseUri := os.Getenv("PYPOWERWALL_BASE_URI"); envBaseUri != "" {
		baseUri = envBaseUri // use environment variable value if it's set
	}

	api := monitor.NewPowerwallApi(baseUri, pb.Logger())
	return &Sampler{
		pocketbase: pb,
		api:        api,
		schedule:   s,
	}
}

func (s *Sampler) Run() {
	now := time.Now()
	tp := s.schedule.GetTariffPeriod(now)

	pwapi, err := s.api.GetPwApi()
	if err != nil {
		s.pocketbase.Logger().Error("sampler: error getting Powerwall API", slog.Any("error", err))
	}

	// save sample
	dao := s.pocketbase.Dao()
	collection, err := dao.FindCollectionByNameOrId("sample")
	if err != nil {
		s.pocketbase.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
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
		s.pocketbase.Logger().Error("Sampler: error saving sample record to collection", slog.Any("error", err))
	}

	// startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05Z")
	// endS := tp.End.In(time.UTC).Format("2006-01-02 15:04:05Z")
	// filter := "tariff = {:tariff} && created >= {:start} && created < {:end}"
	// params := dbx.Params{"start": startS, "end": endS, "tariff": tp.Tariff}
	// records, err := dao.FindRecordsByFilter("sample", filter, "created", -1, 0, params)
	// if err != nil {
	// 	s.pocketbase.Logger().Error("Usager: error finding sample records for usage creation", slog.Any("error", err))
	// }

	// s.pocketbase.Logger().Info("Sampler: found sample records", slog.Int("count", len(records)))
}
