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
	pocketbase *pocketbase.PocketBase
	schedule   monitor.Schedule
}

func NewUsager(pb *pocketbase.PocketBase, s monitor.Schedule) *Usager {
	return &Usager{
		pocketbase: pb,
		schedule:   s,
	}
}

func (s *Usager) Run() {

	now := time.Now()
	tp := s.schedule.GetTariffPeriod(now.Add(-30 * time.Second))

	dao := s.pocketbase.Dao()

	startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05Z")
	endS := tp.End.In(time.UTC).Format("2006-01-02 15:04:05Z")
	filter := "tariff = {:tariff} && created >= {:start} && created < {:end}"
	params := dbx.Params{"start": startS, "end": endS, "tariff": tp.Tariff}
	records, err := dao.FindRecordsByFilter("sample", filter, "created", -1, 0, params)
	if err != nil {
		s.pocketbase.Logger().Error("Usager: error finding sample records for usage creation", slog.Any("error", err))
	}

	if len(records) < 2 {
		s.pocketbase.Logger().Info("Usager: not enough sample records to create usage record", slog.Any("records", records))
		return
	}

	start := records[0]
	end := records[len(records)-1]
	usageRecord := s.createUsageRecord(tp, start, end)

	if err := dao.SaveRecord(usageRecord); err != nil {
		s.pocketbase.Logger().Error("Sampler: error saving usage record to collection", slog.Any("error", err))
	}
}

func (s *Usager) createUsageRecord(tp monitor.TariffPeriod, start *models.Record, end *models.Record) *models.Record {
	s.pocketbase.Logger().Info("Creating usage record", slog.Any("start", start), slog.Any("end", end))

	dao := s.pocketbase.Dao()
	collection, err := dao.FindCollectionByNameOrId("usage")
	if err != nil {
		s.pocketbase.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	//usage = snapshot - end
	homeUsage := end.Get("home_usage").(float64) - start.Get("home_usage").(float64)
	solarProduction := end.Get("solar_production").(float64) - start.Get("solar_production").(float64)
	gridImported := end.Get("grid_imported").(float64) - start.Get("grid_imported").(float64)
	gridExported := end.Get("grid_exported").(float64) - start.Get("grid_exported").(float64)

	record := models.NewRecord(collection)
	record.Set("tariff", tp.Tariff)
	record.Set("start", tp.Start)
	record.Set("end", tp.End)
	record.Set("home_usage", homeUsage)
	record.Set("solar_production", solarProduction)
	record.Set("grid_imported", gridImported)
	record.Set("grid_exported", gridExported)

	return record
}
