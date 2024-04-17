package main

import (
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

// Sampler is `Run` as a cron job to sample the Powerwall API and save the results to the database
// When the date or tariff changes, a usage record is created and saved to the database
type Usager struct {
	pb       *pocketbase.PocketBase
	schedule monitor.Schedule
}

func NewUsager(pb *pocketbase.PocketBase, s monitor.Schedule) *Usager {
	return &Usager{
		pb:       pb,
		schedule: s,
	}
}

func (s *Usager) Run() {
	now := time.Now()
	s.GenerateUsageReport(now)
}

func (s *Usager) GenerateUsageReport(t time.Time) {
	s.pb.Logger().Debug("generating usage report", slog.Any("time", t))
	tp := s.schedule.GetTariffPeriod(t.Add(-5 * time.Minute))

	startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05Z")
	endS := tp.End.In(time.UTC).Format("2006-01-02 15:04:05Z")
	filter := "tariff = {:tariff} && created >= {:start} && created < {:end}"
	params := dbx.Params{"start": startS, "end": endS, "tariff": tp.Tariff}

	dao := s.pb.Dao()
	records, err := dao.FindRecordsByFilter("sample", filter, "created", -1, 0, params)
	s.pb.Logger().Debug("get usage samples", slog.String("filter", filter), slog.Any("params", params))
	if err != nil {
		s.pb.Logger().Error("Usager: error finding sample records for usage creation", slog.Any("error", err))
	}

	if len(records) < 2 {
		s.pb.Logger().Error("Usager: not enough sample records to create usage record", slog.Any("records", records))
		return
	}

	start := records[0]
	end := records[len(records)-1]
	usageRecord := s.createUsageRecord(tp, start, end)

	if err := dao.SaveRecord(usageRecord); err != nil {
		s.pb.Logger().Error("Sampler: error saving usage record to collection", slog.Any("error", err))
	}
}

func (s *Usager) createUsageRecord(tp monitor.TariffPeriod, start *models.Record, end *models.Record) *models.Record {
	dao := s.pb.Dao()
	collection, err := dao.FindCollectionByNameOrId("usage")
	if err != nil {
		s.pb.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	//usage = snapshot - end
	homeUsage := end.Get("home_usage").(float64) - start.Get("home_usage").(float64)
	solarProduction := end.Get("solar_production").(float64) - start.Get("solar_production").(float64)
	gridImported := end.Get("grid_imported").(float64) - start.Get("grid_imported").(float64)
	gridExported := end.Get("grid_exported").(float64) - start.Get("grid_exported").(float64)

	u := models.NewRecord(collection)
	u.Set("tariff", tp.Tariff)
	u.Set("start", tp.Start)
	u.Set("end", tp.End)
	u.Set("home_usage", homeUsage)
	u.Set("solar_production", solarProduction)
	u.Set("grid_imported", gridImported)
	u.Set("grid_exported", gridExported)

	s.pb.Logger().Info("Created usage record", slog.Any("start", start), slog.Any("end", end), slog.Any("usage", u))
	return u
}
