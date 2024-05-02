package fleetdb

import (
	"log/slog"
	"sort"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type Usage struct {
	client   *fleetapi.Client
	schedule *Schedule
	db       *Database
	logger   *slog.Logger
	site     *Site
}

func NewUsage(site *Site, db *Database, client *fleetapi.Client, logger *slog.Logger) *Usage {
	schedule := NewSchedule(site.Tariffs)
	return &Usage{
		schedule: schedule,
		client:   client,
		db:       db,
		logger:   logger,
		site:     site, // for testing
	}
}

type UsageData struct {
	Start           time.Time
	End             time.Time
	HomeUsage       float64
	GridUsage       float64
	SolarProduction float64
	BatteryChange   float64
	Tariff          *Tariff
}

func (u *Usage) GetUsages(site *Site, data []EnergyData) []UsageData {
	var min_date time.Time
	var max_date time.Time
	for _, e := range data {
		if e.Timestamp.Before(min_date) {
			min_date = e.Timestamp
		}
		if e.Timestamp.After(max_date) {
			max_date = e.Timestamp
		}
	}
	tariffById := map[int]Tariff{}
	for _, t := range site.Tariffs {
		tariffById[t.Id] = t
	}

	tariffs := map[int]UsageData{}

	for _, e := range data {
		ud, ok := tariffs[e.TariffId]
		if !ok {
			tariff := tariffById[e.TariffId]
			ud = UsageData{
				Start:  min_date,
				End:    max_date,
				Tariff: &tariff,
			}
		}

		ud.HomeUsage += e.LoadPower
		ud.GridUsage += e.GridPower
		ud.SolarProduction += e.SolarPower
		ud.BatteryChange += e.BatteryPower
		tariffs[e.TariffId] = ud
	}

	var results []UsageData
	for _, ud := range tariffs {
		results = append(results, ud)
	}

	// make result consistent by sorting by tariff name
	sort.Slice(results, func(i, j int) bool {
		return results[i].Tariff.Name < results[j].Tariff.Name
	})

	return results
}
