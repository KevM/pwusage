package main

import "time"

type Schedule struct {
	tariffs []Tariff
}

func NewSchedule(tariffs []Tariff) *Schedule {
	return &Schedule{tariffs: tariffs}
}

type TariffPeriod struct {
	Start  time.Time
	End    time.Time
	Tariff string
}

func (s Schedule) GetTariffPeriod(t time.Time) *TariffPeriod {
	season := s.matchSeasonToDate(t)
	if season == nil {
		return nil
	}

	for _, schedule := range season.Schedules {
		if s.matchDayOfWeek(t, schedule) {
			if s.matchHourOfDay(t, schedule) {

				fromHour := 0
				toHour := 24
				if schedule.FromHour != nil {
					fromHour = *schedule.FromHour
				}
				if schedule.ToHour != nil {
					toHour = *schedule.ToHour
				}

				return &TariffPeriod{
					Start:  time.Date(t.Year(), t.Month(), t.Day(), fromHour, 0, 0, 0, t.Location()),
					End:    time.Date(t.Year(), t.Month(), t.Day(), toHour, 0, 0, 0, t.Location()).Add(-time.Second),
					Tariff: season.Name,
				}
			}
		}
	}

	return &TariffPeriod{}
}

func (s Schedule) matchDayOfWeek(t time.Time, schedule TariffSchedule) bool {
	twd := int(t.Weekday() + 1) // tesla weeks start on Monday=0

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

	if schedule.FromHour != nil && schedule.ToHour != nil {
		return th >= *schedule.FromHour && th <= *schedule.ToHour
	}

	if schedule.ToHour != nil {
		return th <= *schedule.ToHour
	}

	if schedule.FromHour != nil {
		return th >= *schedule.FromHour
	}

	return false
}

func (s Schedule) matchSeasonToDate(t time.Time) *TariffSeason {
	for _, tariff := range s.tariffs {
		for _, season := range tariff.Seasons {
			month := int(t.Month())
			if month >= season.FromMonth && month <= season.ToMonth {
				day := t.Day()
				if day >= season.FromDay && day <= season.ToDay {
					return &season
				}
			}
		}
	}

	return nil
}
