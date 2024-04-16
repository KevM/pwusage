package monitor

import "time"

type TariffPeriod struct {
	Start  time.Time
	End    time.Time
	Tariff string
}

type Schedule interface {
	Active(now time.Time) TariffPeriod
	Prev(now time.Time) time.Time
	Next(now time.Time) time.Time
}

type TariffSchedule struct{}

func (ts *TariffSchedule) Active(now time.Time) TariffPeriod {
	var tariff string
	if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday {
		// if weekend return "Off-Peak"
		tariff = "Off-Peak"
	} else if now.Hour() >= 8 && now.Hour() < 20 {
		tariff = "On-Peak"
	} else {
		tariff = "Off-Peak"
	}

	return TariffPeriod{
		Start:  ts.Prev(now),
		End:    ts.Next(now),
		Tariff: tariff,
	}
}

func (ts *TariffSchedule) Prev(now time.Time) time.Time {
	location := now.Location()
	dayofweek := now.Weekday()
	hour := now.Hour()
	isWeekday := dayofweek > time.Sunday && dayofweek < time.Saturday
	if isWeekday {
		if hour >= 0 && hour < 8 {
			// retrun midnight of the previous day
			return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
		}
		if hour >= 8 && hour < 20 {
			// return 8am of the same day
			return time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, location)
		}
		if hour >= 20 && hour < 24 {
			// return 8pm of the same day
			return time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, location)
		}
	}

	// for weekend return midnight of the previous day (remember we don't want to cross date boundarys)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
}

func (ts *TariffSchedule) Next(now time.Time) time.Time {
	location := now.Location()
	dayofweek := now.Weekday()
	hour := now.Hour()
	isWeekday := dayofweek > time.Sunday && dayofweek < time.Saturday
	if isWeekday {
		if hour >= 0 && hour < 8 {
			return time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, location)
		}
		if hour >= 8 && hour < 20 {
			return time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, location)
		}
		if hour >= 20 && hour < 24 {
			return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location).AddDate(0, 0, 1)
		}
	}

	// for weekend return midnight of the next day (remember we don't want to cross date boundarys)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location).AddDate(0, 0, 1)
}
