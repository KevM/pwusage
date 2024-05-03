package fleetdb

import "time"

type Schedule struct {
	tariffs []Tariff
}

func NewSchedule(tariffs []Tariff) *Schedule {
	return &Schedule{tariffs: tariffs}
}

type TariffPeriod struct {
	Start    time.Time
	End      time.Time
	Tariff   *Tariff
	Season   *TariffSeason
	Schedule *TariffSchedule
}

func (s Schedule) GetSeason(t time.Time) *TariffSeason {
	for _, tariff := range s.tariffs {
		for _, season := range tariff.Seasons {
			if matchSeason(t, season) {
				return &season
			}
		}
	}

	return nil
}

// GetTariffPeriod returns the tariff period matching the given time
func (s Schedule) GetTariffPeriod(t time.Time) *TariffPeriod {
	for _, tariff := range s.tariffs {
		for _, season := range tariff.Seasons {
			if !matchSeason(t, season) {
				continue
			}

			for _, schedule := range season.Schedules {
				if !s.matchSchedule(t, schedule) {
					continue
				}

				fromHour := 0
				toHour := 24
				if schedule.FromHour != nil {
					fromHour = *schedule.FromHour
				}
				if schedule.ToHour != nil {
					toHour = *schedule.ToHour
				}

				return &TariffPeriod{
					Start:    time.Date(t.Year(), t.Month(), t.Day(), fromHour, 0, 0, 0, t.Location()),
					End:      time.Date(t.Year(), t.Month(), t.Day(), toHour, 0, 0, 0, t.Location()),
					Tariff:   &tariff,
					Season:   &season,
					Schedule: &schedule,
				}
			}
		}
	}

	return nil
}

func (s Schedule) matchSchedule(t time.Time, schedule TariffSchedule) bool {
	if s.matchDayOfWeek(t, schedule) {
		if s.matchHourOfDay(t, schedule) {
			return true
		}
	}

	return false
}

// toTeslaWeekday converts Go's weekday to Tesla's weekday where Monday is 0 and Sunday is 6
func toTeslaWeekday(wd int) int {
	if wd == 0 {
		return 6
	}
	return wd - 1
}

func (s Schedule) matchDayOfWeek(t time.Time, schedule TariffSchedule) bool {
	twd := toTeslaWeekday(int(t.Weekday()))

	if schedule.FromDayOfWeek != nil && schedule.ToDayOfWeek != nil {
		return twd >= *schedule.FromDayOfWeek && twd <= *schedule.ToDayOfWeek
	}

	if schedule.ToDayOfWeek != nil {
		return twd <= *schedule.ToDayOfWeek
	}

	if schedule.FromDayOfWeek != nil {
		return twd >= *schedule.FromDayOfWeek
	}

	return false
}

func (s Schedule) matchHourOfDay(t time.Time, schedule TariffSchedule) bool {
	th := t.Hour()

	if schedule.FromHour == nil && schedule.ToHour == nil {
		return true // no hour restrictions means always matching the day
	}

	if schedule.FromHour != nil && schedule.ToHour != nil {
		return th >= *schedule.FromHour && th < *schedule.ToHour
	}

	if schedule.ToHour != nil {
		return th < *schedule.ToHour
	}

	if schedule.FromHour != nil {
		return th >= *schedule.FromHour
	}

	return false
}

func matchSeason(t time.Time, season TariffSeason) bool {
	month := int(t.Month())
	betweenFromTo := true
	if season.ToMonth < season.FromMonth {
		betweenFromTo = false
	}

	if betweenFromTo {
		if month >= season.FromMonth && month <= season.ToMonth && matchDay(t, season) {
			return true
		}
	} else {
		if (month >= season.FromMonth || month <= season.ToMonth) && matchDay(t, season) {
			return true
		}
	}
	return false
}

func matchDay(t time.Time, season TariffSeason) bool {
	day := t.Day()
	return day >= season.FromDay && day <= season.ToDay
}
