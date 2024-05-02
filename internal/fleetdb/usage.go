package fleetdb

import (
	"fmt"
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
	HomeUsage       float64
	GridUsage       float64
	SolarProduction float64
	BatteryChange   float64
	Tariff          *Tariff
}

func (u *Usage) GetEnergyUsage(startDate time.Time, endDate time.Time) ([]UsageData, error) {
	query := `
        SELECT tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage FROM EnergyUsage
        WHERE start >= ? AND start < ?
    `
	rows, err := u.db.Conn().Query(query, startDate.Format("2006-01-02 15:04:05"), endDate.Format("2006-01-02 15:04:05"))
	if err != nil {
		return nil, fmt.Errorf("error querying EnergyUsage: %w", err)
	}
	defer rows.Close()

	tariffsById := map[int]Tariff{}
	for _, t := range u.site.Tariffs {
		tariffsById[t.Id] = t
	}

	var usages []UsageData
	for rows.Next() {
		var ud UsageData
		var tariffId int
		err = rows.Scan(&tariffId, &ud.Start, &ud.HomeUsage, &ud.SolarProduction, &ud.GridUsage, &ud.BatteryChange)
		if err != nil {
			return nil, fmt.Errorf("error scanning usage data row: %w", err)
		}

		t, ok := tariffsById[tariffId]
		if !ok {
			return nil, fmt.Errorf("tariff not found for id %d", tariffId)
		}
		ud.Tariff = &t
		usages = append(usages, ud)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating rows: %w", err)
	}

	return usages, nil
}

func (u *Usage) GetUsagesFromData(site *Site, data []EnergyData) []UsageData {
	var min_date time.Time = time.Now().AddDate(1, 0, 0)
	for _, e := range data {
		if e.Timestamp.Before(min_date) {
			min_date = e.Timestamp
		}
	}
	usage_date := time.Date(min_date.Year(), min_date.Month(), min_date.Day(), 0, 0, 0, 0, min_date.Location())

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
				Start:  usage_date,
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
