package main

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/neomantra/ymdflag"
	"github.com/pocketbase/dbx"
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
	Range   string        `json:"date_range"`
	Start   time.Time     `json:"start_date"`
	End     time.Time     `json:"end_date"`
	Tariffs []TariffUsage `json:"tariffs"`
}

type Reporter struct {
	pb       *pocketbase.PocketBase
	location *time.Location
}

func NewReporter(pb *pocketbase.PocketBase, location *time.Location) *Reporter {
	return &Reporter{
		pb:       pb,
		location: location,
	}
}

func (r *Reporter) GetUsageReport(dateGrouping string, start ymdflag.YMDFlag) (UsageReport, error) {
	var result UsageReport
	rangeFound, end := r.FindEndDate(dateGrouping, start)
	result.Range = rangeFound

	// get usages between start and end
	result.Start = start.AsTimeWithLoc(r.location).In(time.UTC)
	result.End = end.AsTimeWithLoc(r.location).In(time.UTC)
	startS := result.Start.Format("2006-01-02 15:04:05Z")
	endS := result.End.Format("2006-01-02 15:04:05Z")
	filter := "start >= {:start} && end <= {:end}"
	params := dbx.Params{"start": startS, "end": endS}
	r.pb.Logger().Debug("Getting usage report", slog.String("date_group", dateGrouping), slog.String("start", startS), slog.String("end", endS))
	usages, err := r.pb.Dao().FindRecordsByFilter("usage", filter, "start", -1, 0, params)
	if err != nil {
		return result, fmt.Errorf("error getting usages for range %s from %s to %s: %w", dateGrouping, startS, endS, err)
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
