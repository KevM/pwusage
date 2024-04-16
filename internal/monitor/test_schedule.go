package monitor

import "time"

type TestSchedule struct{}

func (ts TestSchedule) GetTariffPeriod(now time.Time) TariffPeriod {
	var tariff string
	if now.Hour()%2 == 0 {
		tariff = "Off-Peak"
	} else {
		tariff = "On-Peak"
	}

	return TariffPeriod{
		Start:  ts.Prev(now),
		End:    ts.Next(now),
		Tariff: tariff,
	}
}

func (ts TestSchedule) Prev(now time.Time) time.Time {
	return now.Add(-1 * time.Minute)
}

func (ts TestSchedule) Next(now time.Time) time.Time {
	return now.Add(1 * time.Minute)
}
