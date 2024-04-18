package main

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

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
	now := s.schedule.Now()
	s.pb.Logger().Debug("running usager scheduled job", slog.Any("time", now))
	tp := s.schedule.GetTariffPeriod(now)
	_, err := s.UpsertUsage(tp)
	if err != nil {
		s.pb.Logger().Error("usager: error generating usage report", slog.Any("error", err))
	}
}

// UpsertUsage creates a usage record for the given tariff period.
// If an existing usage record exists it updated
func (s *Usager) UpsertUsage(tp monitor.TariffPeriod) (*models.Record, error) {
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

func (s *Usager) Backfill(start time.Time, end time.Time) error {
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

func findRangeUsage(tp monitor.TariffPeriod, usages []*models.Record) *models.Record {
	for _, eu := range usages {
		tariff := eu.Get("tariff").(string)
		if tariff != tp.Tariff {
			continue
		}
		s := eu.GetDateTime("start").Time()
		e := eu.GetDateTime("end").Time()

		startMatch := (tp.Start.Before(s) || tp.Start.Equal(s))
		endMatch := (tp.End.After(e) || tp.End.Equal(e))

		if startMatch && endMatch {
			return eu
		}
	}

	return nil
}
