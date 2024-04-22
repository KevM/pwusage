package main

import (
	"fmt"
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

type CurrentlyReport struct {
	Grid_exported  float64 `json:"grid_exported"`
	Grid_imported  float64 `json:"grid_imported"`
	Load_imported  float64 `json:"load_imported"`
	Solar_exported float64 `json:"solar_exported"`
	Battery_SOC    float64 `json:"battery_soc"`
	Tariff         string  `json:"tariff"`
}

type DashboardReport struct {
	Start     time.Time       `json:"start"`
	Currently CurrentlyReport `json:"currently"`
	Year      UsageReport     `json:"year"`
	Month     UsageReport     `json:"month"`
	Week      UsageReport     `json:"week"`
	Day       UsageReport     `json:"day"`
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

func (r *Reporter) GetCurrentlyReport(t time.Time) (CurrentlyReport, error) {
	tp := r.schedule.GetTariffPeriod(t)
	sr := monitor.NewSampleRepo(r.pb)
	sample, err := sr.GetLastTariffPeriodSample(tp)
	if err != nil {
		return CurrentlyReport{}, fmt.Errorf("error getting last tariff period sample: %w", err)
	}

	result := CurrentlyReport{
		Grid_exported:  sample.GetFloat("grid_exported"),
		Grid_imported:  sample.GetFloat("grid_imported"),
		Load_imported:  sample.GetFloat("home_usage"),
		Solar_exported: sample.GetFloat("solar_production"),
		Battery_SOC:    sample.GetFloat("battery_charge"),
		Tariff:         tp.Tariff,
	}

	return result, nil
}

func (r *Reporter) GetDashboardReport(t time.Time) (DashboardReport, error) {
	var result DashboardReport
	currently, err := r.GetCurrentlyReport(t)
	if err != nil {
		return result, fmt.Errorf("error getting currently report: %w", err)
	}
	result.Currently = currently

	start := ymdflag.NewYMDFlag(t)
	year, err := r.GetUsageReport(YearRange, start)
	if err != nil {
		return result, fmt.Errorf("error getting year report: %w", err)
	}
	result.Year = year

	month, err := r.GetUsageReport(MonthRange, start)
	if err != nil {
		return result, fmt.Errorf("error getting month report: %w", err)
	}
	result.Month = month

	week, err := r.GetUsageReport(WeekRange, start)
	if err != nil {
		return result, fmt.Errorf("error getting week report: %w", err)
	}
	result.Week = week

	day, err := r.GetUsageReport(DayRange, start)
	if err != nil {
		return result, fmt.Errorf("error getting week report: %w", err)
	}
	result.Day = day

	return result, nil
}

func (r *Reporter) GetUsageReport(dateGrouping string, start ymdflag.YMDFlag) (UsageReport, error) {
	rangeFound, end := r.FindEndDate(dateGrouping, start)
	s := start.AsTimeWithLoc(r.location)
	e := end.AsTimeWithLoc(r.location)

	result := UsageReport{
		Start: s,
		End:   e,
		Range: rangeFound,
	}

	repo := monitor.NewUsageRepo(r.pb)
	usages, err := repo.GetUsagesBetween(s, e)
	if err != nil {
		return result, fmt.Errorf("error getting usages for range %s starting at %s: %w", dateGrouping, start.AsYMDString(), err)
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
