package main

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/pocketbase/pocketbase"
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
	now := time.Now()
	err := s.GenerateUsage(now)
	if err != nil {
		s.pb.Logger().Error("usager: error generating usage report", slog.Any("error", err))
	}
}

func (s *Usager) GenerateUsage(t time.Time) error {
	s.pb.Logger().Debug("generating usage report", slog.Any("time", t))
	tp := s.schedule.GetTariffPeriod(t.Add(-5 * time.Minute))

	repo := monitor.NewUsageRepo(s.pb)
	start, end, err := repo.GetUsageSamples(tp)
	if err != nil {
		return fmt.Errorf("error getting usage samples: %w", err)
	}

	ur := repo.CreateUsageRecord(tp, start, end)
	if err := s.pb.Dao().SaveRecord(ur); err != nil {
		return fmt.Errorf("error saving usage record: %w", err)
	}

	return nil
}
