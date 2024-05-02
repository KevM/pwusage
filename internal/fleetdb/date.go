package fleetdb

import (
	"time"
)

const (
	// ranges
	DayRange   = "day"
	WeekRange  = "week"
	MonthRange = "month"
	YearRange  = "year"
)

func GetDateRange(date_range string, relativeTo time.Time) (time.Time, time.Time) {
	start := time.Date(relativeTo.Year(), relativeTo.Month(), relativeTo.Day(), 0, 0, 0, 0, relativeTo.Location())
	switch date_range {
	case WeekRange:
		sow := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, start.Location()).AddDate(0, 0, -int(start.Weekday()))
		eow := sow.AddDate(0, 0, 7)
		return sow, eow
	case MonthRange:
		som := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, start.Location())
		eom := start.AddDate(0, 1, 0)
		return som, eom
	case YearRange:
		soy := time.Date(start.Year(), 1, 1, 0, 0, 0, 0, start.Location())
		eoy := start.AddDate(1, 0, 0)
		return soy, eoy
	default:
		return start, start.AddDate(0, 0, 1)
	}
}
