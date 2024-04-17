package monitor

import (
	"fmt"
	"time"

	"github.com/neomantra/ymdflag"
)

const (
	// ranges
	DayRange   = "day"
	WeekRange  = "week"
	MonthRange = "month"
	YearRange  = "year"
)

func VerifyRangeStart(dateGrouping string, start string, base time.Time) (string, ymdflag.YMDFlag, error) {

	if dateGrouping == "" {
		dateGrouping = MonthRange
	}

	if start != "" {
		startDate, err := VerifyDate(start)
		if err != nil {
			return dateGrouping, ymdflag.YMDFlag{}, err
		}
		return dateGrouping, startDate, nil
	}

	// start is not set so we need to figure out what it should be for the selected range
	switch dateGrouping {
	case WeekRange:
		sow := time.Date(base.Year(), base.Month(), base.Day(), 0, 0, 0, 0, base.Location()).AddDate(0, 0, -int(base.Weekday()))
		return WeekRange, ymdflag.NewYMDFlag(sow), nil
	case MonthRange:
		som := time.Date(base.Year(), base.Month(), 1, 0, 0, 0, 0, base.Location())
		return MonthRange, ymdflag.NewYMDFlag(som), nil
	case YearRange:
		soy := time.Date(base.Year(), 1, 1, 0, 0, 0, 0, base.Location())
		return YearRange, ymdflag.NewYMDFlag(soy), nil
	default:
		return DayRange, ymdflag.NewYMDFlag(base), nil
	}
}

func VerifyDate(in string) (ymdflag.YMDFlag, error) {
	if in == "" {
		return ymdflag.YMDFlag{}, nil
	}
	startDate := ymdflag.YMDFlag{}
	err := startDate.Set(in)
	if err != nil {
		return startDate, fmt.Errorf("date must be a valid date. Error: %w", err)
	}

	return startDate, nil
}
