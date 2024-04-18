package main

import (
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/kevm/pw-usage/internal/monitor"
	"github.com/neomantra/ymdflag"
	"github.com/pocketbase/pocketbase"
)

const (
	// ranges
	DayRange   = "day"
	WeekRange  = "week"
	MonthRange = "month"
	YearRange  = "year"
)

type TariffUsage struct {
	Tariff          string  `json:"tariff"`
	HomeUsage       float64 `json:"home_usage"`
	SolarProduction float64 `json:"solar_production"`
	GridImported    float64 `json:"grid_imported"`
	GridExported    float64 `json:"grid_exported"`
}

type UsageReport struct {
	Range   string        `json:"range"`
	Start   time.Time     `json:"start"`
	End     time.Time     `json:"end"`
	Tariffs []TariffUsage `json:"tariffs"`
}

type Reporter struct {
	pb       *pocketbase.PocketBase
	location *time.Location
	schedule monitor.Schedule
}

func NewReporter(pb *pocketbase.PocketBase, schedule monitor.Schedule, location *time.Location) *Reporter {
	return &Reporter{
		pb:       pb,
		location: location,
		schedule: schedule,
	}
}

func (r *Reporter) GetUsageReport(dateGrouping string, start ymdflag.YMDFlag) (UsageReport, error) {
	rangeFound, end := r.FindEndDate(dateGrouping, start)
	result := UsageReport{
		Start: start.AsTimeWithLoc(r.location),
		End:   end.AsTimeWithLoc(r.location),
		Range: rangeFound,
	}

	repo := monitor.NewUsageRepo(r.pb)
	usages, err := repo.GetUsagesBetween(start, end, r.location)
	if err != nil {
		return result, fmt.Errorf("error getting usages for range %s starting at %s: %w", dateGrouping, start.AsYMDString(), err)
	}

	now := time.Now().In(r.location)
	if start == ymdflag.NewYMDFlag(now) {
		// get usage for current tarrif period
		tp := r.schedule.GetTariffPeriod(now)
		start, end, err := repo.GetUsageSamples(tp)
		if err != nil {
			return result, fmt.Errorf("error getting usage samples for today's current tarrif: %w", err)
		}

		ur := repo.CreateUsageRecord(tp, start, end)
		r.pb.Logger().Debug("Appending current approximate usage for today's report", slog.Any("current usage", ur))
		usages = append(usages, ur)
	}

	// group by tariff
	tariffs := make(map[string]*TariffUsage)
	for _, usage := range usages {
		tariff := usage.Get("tariff").(string)
		if _, ok := tariffs[tariff]; !ok {
			tariffs[tariff] = &TariffUsage{
				Tariff:          tariff,
				HomeUsage:       0,
				SolarProduction: 0,
				GridImported:    0,
				GridExported:    0,
			}
		}

		tu := tariffs[tariff]
		tu.HomeUsage += usage.Get("home_usage").(float64)
		tu.SolarProduction += usage.Get("solar_production").(float64)
		tu.GridImported += usage.Get("grid_imported").(float64)
		tu.GridExported += usage.Get("grid_exported").(float64)
	}

	result.Tariffs = make([]TariffUsage, 0, len(tariffs))
	for _, tu := range tariffs {
		result.Tariffs = append(result.Tariffs, *tu)
	}

	sort.Slice(result.Tariffs, func(i, j int) bool {
		return result.Tariffs[i].Tariff < result.Tariffs[j].Tariff
	})

	return result, nil
}

func (r *Reporter) FindEndDate(date_group string, start ymdflag.YMDFlag) (string, ymdflag.YMDFlag) {
	group := normalizeDateGroup(date_group)
	switch group {
	case WeekRange:
		e := start.AsTimeWithLoc(time.UTC).AddDate(0, 0, 7)
		return WeekRange, ymdflag.NewYMDFlag(e)
	case MonthRange:
		e := start.AsTimeWithLoc(time.UTC).AddDate(0, 1, 0)
		return MonthRange, ymdflag.NewYMDFlag(e)
	case YearRange:
		e := start.AsTimeWithLoc(time.UTC).AddDate(1, 0, 0)
		return YearRange, ymdflag.NewYMDFlag(e)
	default:
		e := start.AsTimeWithLoc(time.UTC).AddDate(0, 0, 1)
		return DayRange, ymdflag.NewYMDFlag(e)
	}
}

func normalizeDateGroup(r string) string {
	switch r {
	case DayRange:
		return DayRange
	case WeekRange:
		return WeekRange
	case MonthRange:
		return MonthRange
	case YearRange:
		return YearRange
	}

	return MonthRange
}
