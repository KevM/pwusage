package history

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/neomantra/ymdflag"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

type SampleBackfiller struct {
	fleetapi *fleetapi.FleetApiClient
	pb       *pocketbase.PocketBase
	schedule monitor.Schedule
}

func NewSampleBackfiller(token string, pb *pocketbase.PocketBase, s monitor.Schedule) *SampleBackfiller {
	api := fleetapi.NewFleetApiClient(token, pb.Logger())
	return &SampleBackfiller{
		pb:       pb,
		fleetapi: &api,
		schedule: s,
	}
}

func (s *SampleBackfiller) Backfill(siteid string, start ymdflag.YMDFlag, end ymdflag.YMDFlag, gaplimit time.Duration, tz *time.Location) error {
	sr := monitor.NewSampleRepo(s.pb)
	logger := s.pb.Logger().With(slog.String("siteid", siteid), slog.String("start", start.String()), slog.String("end", end.String()))
	backfills, err := sr.GetSampleGaps(start, end, gaplimit)
	if err != nil {
		return fmt.Errorf("error getting sample gaps: %w", err)
	}

	if len(backfills) == 0 {
		logger.Info("no backfills needed")
		return nil
	}

	logger.Debug("backfilling samples", slog.Int("count", len(backfills)))
	dayImports := make([]monitor.Backfill, 0, len(backfills))
	for _, b := range backfills {
		if b.End.Sub(b.Start) < 24*time.Hour {
			dayImports = append(dayImports, b)
			continue
		}

		// create a backfill for each day bewteen start and end
		for d := b.Start; d.Before(b.End); d = d.AddDate(0, 0, 1) {
			dayEnd := d.AddDate(0, 0, 1).Add(-1 * time.Millisecond)
			dayImports = append(dayImports, monitor.Backfill{Start: d, End: dayEnd})
		}
	}

	collection, err := s.pb.Dao().FindCollectionByNameOrId("sample")
	if err != nil {
		return fmt.Errorf("sample: error finding collection: %w", err)
	}

	logger.Debug("backfils split into days", slog.Int("count", len(dayImports)))
	for _, b := range dayImports {
		logger.Debug("getting history for day", slog.String("start", b.Start.String()))
		history, err := s.fleetapi.GetEnergyHistory(siteid, b.Start, b.End, fleetapi.HistoryPeriod_Day, tz)
		if err != nil {
			return fmt.Errorf("error getting energy history for range %s to %s: %w", b.Start, b.End, err)
		}

		for _, h := range history {
			if h.Timestamp.Before(b.Start) || h.Timestamp.After(b.End) {
				continue // skip samples outside of the backfill range
			}

			err := s.SaveHistoricSample(collection, h)
			if err != nil {
				return fmt.Errorf("error saving sample: %w", err)
			}
		}
	}

	return nil
}

func (s *SampleBackfiller) SaveHistoricSample(c *models.Collection, e fleetapi.EnergyHistoryEntry) error {
	tp := s.schedule.GetTariffPeriod(e.Timestamp)
	sr := models.NewRecord(c)
	sr.Set("tariff", tp.Tariff)
	sr.Set("timestamp", e.Timestamp)
	// sr.Set("home_usage", e.TotalHomeUsage)
	// sr.Set("solar_production", e.SolarEnergyExported)
	// sr.Set("grid_imported", e.GridEnergyImported)
	// sr.Set("grid_exported", e.TotalGridEnergyExported)
	// sr.Set("battery_charge", pwapi.Soe)
	sr.Set("current_battery_usage", e.BatteryEnergyExported)
	sr.Set("current_home_usage", e.TotalHomeUsage)
	sr.Set("current_solar_production", e.SolarEnergyExported)
	sr.Set("current_grid_usage", e.GridEnergyImported)

	if err := s.pb.Dao().SaveRecord(sr); err != nil {
		return fmt.Errorf("sample: error saving historical sample record: %w", err)
	}

	return nil
}
