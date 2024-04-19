package main

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

type Backfill struct {
	pb       *pocketbase.PocketBase
	schedule monitor.Schedule
}

func NewBackfill(pb *pocketbase.PocketBase, s monitor.Schedule) *Backfill {
	return &Backfill{
		pb:       pb,
		schedule: s,
	}
}

func (s *Backfill) Backfill(start time.Time, end time.Time) error {
	ur := monitor.NewUsageRepo(s.pb)

	// walk forward 1 hour at a time and generate usage reports when the tariff period changes
	var last_tp monitor.TariffPeriod
	for t := start; t.Before(end); t = t.Add(time.Hour) {
		tp := s.schedule.GetTariffPeriod(t)
		if tp == last_tp {
			continue
		}
		last_tp = tp

		if tp.End.After(s.schedule.Now()) {
			// skip tariff period we are currently experiencing
			return nil
		}

		usage, err := ur.GetTariffPeriodUsages(tp)
		if err != nil {
			return fmt.Errorf("error getting tariff period usage for backfill: %w", err)
		}
		if usage != nil {
			// skip if usage record already exists
			continue
		}

		s.pb.Logger().Info("Creating backfill usage report", slog.Any("time", t))
		_, err = s.UpsertUsage(tp)
		if err != nil {
			return fmt.Errorf("error generating usage report for backfill: %w", err)
		}
	}

	return nil
}

func (s *Backfill) UpsertUsage(tp monitor.TariffPeriod) (*models.Record, error) {
	repo := monitor.NewUsageRepo(s.pb)
	ur, err := repo.GetTariffPeriodUsages(tp)
	if err != nil {
		return nil, fmt.Errorf("error getting to maybe upsertL %w", err)
	}

	s.pb.Logger().Debug("generating usage report", slog.Any("period", tp))
	start, end, err := repo.GetUsageSamples(tp)
	if err != nil {
		return nil, fmt.Errorf("error getting usage samples: %w", err)
	}

	ur = repo.CreateUsageRecord(ur, tp, start, end)
	if err := s.pb.Dao().SaveRecord(ur); err != nil {
		return nil, fmt.Errorf("error saving usage record: %w", err)
	}

	return ur, nil
}
