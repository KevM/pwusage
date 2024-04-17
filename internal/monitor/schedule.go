package monitor

import "time"

type TariffPeriod struct {
	Start  time.Time
	End    time.Time
	Tariff string
}

type Schedule interface {
	GetTariffPeriod(now time.Time) TariffPeriod
	Prev(now time.Time) time.Time
	Next(now time.Time) time.Time
}

type TimeOfUse struct {
	location *time.Location
}

func NewTimeOfUse(location *time.Location) TimeOfUse {
	return TimeOfUse{
		location: location,
	}
}

func (ts TimeOfUse) GetTariffPeriod(now time.Time) TariffPeriod {
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

func (ts TimeOfUse) Prev(now time.Time) time.Time {
	dayofweek := now.Weekday()
	hour := now.Hour()
	isWeekday := dayofweek > time.Sunday && dayofweek < time.Saturday
	if isWeekday {
		if hour >= 0 && hour < 8 {
			// retrun midnight of the previous day
			return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ts.location)
		}
		if hour >= 8 && hour < 20 {
			// return 8am of the same day
			return time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, ts.location)
		}
		if hour >= 20 && hour < 24 {
			// return 8pm of the same day
			return time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, ts.location)
		}
	}

	// for weekend return midnight of the previous day (remember we don't want to cross date boundarys)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ts.location)
}

func (ts TimeOfUse) Next(now time.Time) time.Time {
	dayofweek := now.Weekday()
	hour := now.Hour()
	isWeekday := dayofweek > time.Sunday && dayofweek < time.Saturday
	if isWeekday {
		if hour >= 0 && hour < 8 {
			return time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, ts.location)
		}
		if hour >= 8 && hour < 20 {
			return time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, ts.location)
		}
		if hour >= 20 && hour < 24 {
			return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ts.location).AddDate(0, 0, 1)
		}
	}

	// for weekend return midnight of the next day (remember we don't want to cross date boundarys)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, ts.location).AddDate(0, 0, 1)
}
