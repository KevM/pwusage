package fleetdb

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type EnergyData struct {
	Timestamp    time.Time
	LoadPower    float64
	SolarPower   float64
	GridPower    float64
	BatteryPower float64
	TariffId     int
	SiteId       string
}

type EnergyRepo struct {
	db     *Database
	logger *slog.Logger
}

func NewEnergyRepo(db *Database, logger *slog.Logger) *EnergyRepo {
	return &EnergyRepo{db: db, logger: logger}
}

func (r EnergyRepo) GetEnergies(start time.Time, end time.Time) ([]EnergyData, error) {
	sql := `SELECT timestamp, site_id, tariff_id, load_power, solar_power, grid_power, battery_power 
			FROM EnergyData 
			WHERE timestamp >= ? AND timestamp < ?`

	rows, err := r.db.Conn().Query(sql, start, end)
	if err != nil {
		return nil, fmt.Errorf("error querying energies: %w", err)
	}
	defer rows.Close()

	var results []EnergyData
	for rows.Next() {
		var e EnergyData
		err := rows.Scan(&e.Timestamp, &e.SiteId, &e.TariffId, &e.LoadPower, &e.SolarPower, &e.GridPower, &e.BatteryPower)
		if err != nil {
			return nil, err
		}
		results = append(results, e)
	}

	return results, nil
}

type Site struct {
	Id        string
	Name      string
	Updated   time.Time
	Installed time.Time
	Location  *time.Location
	JSON      string
	Tariffs   []Tariff
}

// site -> tariff
type Tariff struct {
	Id      int
	SiteId  string
	Name    string
	Updated time.Time
	Seasons []TariffSeason
}

func (t Tariff) FindSeason(timestamp time.Time) *TariffSeason {
	for _, s := range t.Seasons {
		if matchSeason(timestamp, s) {
			return &s
		}
	}
	return nil
}

// site -> tariff -> season
type TariffSeason struct {
	Id        int
	TariffId  int
	Name      string
	FromMonth int
	FromDay   int
	ToMonth   int
	ToDay     int
	BuyRate   float64
	SellRate  float64
	Schedules []TariffSchedule
}

// site -> tariff -> season -> schedule
type TariffSchedule struct {
	Id            int
	SeasonId      int
	FromDayOfWeek *int
	FromHour      *int
	ToDayOfWeek   *int
	ToHour        *int
}

func (r EnergyRepo) LoadSite(siteid string, client *fleetapi.Client) (*Site, error) {
	info, err := client.GetEnergySiteInfo(siteid)
	if err != nil {
		return nil, fmt.Errorf("error getting energy site info: %w", err)
	}

	site, err := r.UpsertSite(siteid, info)
	if err != nil {
		return nil, fmt.Errorf("error upserting site info: %w", err)
	}

	return site, nil
}

func (r EnergyRepo) UpsertSite(siteid string, fleetSiteInfo *fleetapi.EnergySiteInfo) (*Site, error) {
	jsonData, err := json.Marshal(fleetSiteInfo)
	if err != nil {
		return nil, fmt.Errorf("error marshaling site data: %w", err)
	}

	installed := fleetSiteInfo.InstallationDate
	location, err := time.LoadLocation(fleetSiteInfo.InstallationTimeZone)
	if err != nil {
		return nil, fmt.Errorf("error loading site tz location: %w", err)
	}

	// find max gateway updated time
	var updated time.Time
	for _, gateway := range fleetSiteInfo.Components.Gateways {
		if gateway.UpdatedDatetime.After(updated) {
			updated = gateway.UpdatedDatetime
		}
	}

	// upsert site
	insertSql := `INSERT INTO Site(id, name, updated, installed, timezone, json) VALUES (?, ?, ?, ?, ?, ?) 
				  ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, installed = excluded.installed, timezone = excluded.timezone, json = excluded.json;`
	_, err = r.db.Conn().Exec(insertSql, siteid, fleetSiteInfo.SiteName, updated, installed, fleetSiteInfo.InstallationTimeZone, jsonData)
	if err != nil {
		return nil, fmt.Errorf("error upserting site %s info query: %w", fleetSiteInfo.ID, err)
	}

	site := Site{
		Id:        siteid,
		Name:      fleetSiteInfo.SiteName,
		Updated:   updated,
		Installed: installed,
		Location:  location,
		JSON:      string(jsonData),
	}

	site, err = r.upsertSiteTariffs(site, fleetSiteInfo)
	if err != nil {
		return nil, fmt.Errorf("error upserting site tariffs for site %s: %w", site.Id, err)
	}

	return &site, nil
}

func (r EnergyRepo) upsertSiteTariffs(site Site, fleetSiteInfo *fleetapi.EnergySiteInfo) (Site, error) {
	tariffs := []Tariff{}
	for _, name := range findSiteTariffNames(fleetSiteInfo) {
		tariff, err := r.upsertTariff(name, site, fleetSiteInfo)
		if err != nil {
			return site, fmt.Errorf("error upserting tariff %s for site %s: %w", name, site.Id, err)
		}
		tariffs = append(tariffs, *tariff)
	}

	site.Tariffs = tariffs
	return site, nil
}

func findSiteTariffNames(site *fleetapi.EnergySiteInfo) []string {
	tariffMap := map[string]interface{}{}
	for _, tariff := range site.TariffContentV2.Seasons {
		for name := range tariff.TouPeriods {
			tariffMap[name] = tariff
		}
	}
	tariffs := []string{}
	for name := range tariffMap {
		tariffs = append(tariffs, name)
	}

	return tariffs
}

func (r EnergyRepo) upsertTariff(name string, site Site, fleetSiteInfo *fleetapi.EnergySiteInfo) (*Tariff, error) {
	tariff := &Tariff{
		SiteId:  site.Id,
		Name:    name,
		Updated: site.Updated,
	}
	insertSql := `INSERT INTO Tariff(site_id, name, updated) VALUES (?, ?, ?)
				  ON CONFLICT(site_id, name) DO UPDATE SET updated = excluded.updated;`
	_, err := r.db.Conn().Exec(insertSql, site.Id, name, site.Updated, site.Updated)
	if err != nil {
		return tariff, fmt.Errorf("error upserting site tariff %s: %w", name, err)
	}

	// get tariff id for this site in case it was an update as that would make the current id incorrect
	tariffIdQuery := `SELECT id FROM Tariff WHERE site_id = ? AND name = ?`
	row := r.db.Conn().QueryRow(tariffIdQuery, site.Id, name)
	var tariffId int
	err = row.Scan(&tariffId)
	if err != nil {
		return tariff, fmt.Errorf("error querying tariff id for site %s: %w", site.Id, err)
	}
	tariff.Id = tariffId

	// delete all tariff seasons (cascading to schedules) for this tariff
	deleteSql := `DELETE FROM TariffSeason WHERE tariff_id = ?`
	_, err = r.db.Conn().Exec(deleteSql, tariffId)
	if err != nil {
		return tariff, fmt.Errorf("error deleting seasons for tariff %s: %w", name, err)
	}

	// insert tariff seasons and schedules
	seasons, err := getSeasonsFromFleetSiteInfo(tariff, fleetSiteInfo)
	if err != nil {
		return tariff, fmt.Errorf("error getting seasons for tariff %s: %w", name, err)
	}

	for _, season := range seasons {
		insertSeasonSql := `INSERT INTO TariffSeason(tariff_id, name, 
							from_month, from_day, to_month, to_day, buy_rate, sell_rate)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		res, err := r.db.Conn().Exec(insertSeasonSql, tariff.Id, season.Name, season.FromMonth, season.FromDay, season.ToMonth, season.ToDay, season.BuyRate, season.SellRate)
		if err != nil {
			return tariff, fmt.Errorf("error inserting season for tariff %s: %w", season.Name, err)
		}
		seasonId, err := res.LastInsertId()
		if err != nil {
			return tariff, fmt.Errorf("error getting season id for tariff %s: %w", season.Name, err)
		}
		season.Id = int(seasonId)

		for _, schedule := range season.Schedules {
			insertScheduleSql := `INSERT INTO TariffSchedule(season_id, 
								  from_day_of_week, from_hour, to_day_of_week, to_hour)
								  VALUES (?, ?, ?, ?, ?)`
			res, err = r.db.Conn().Exec(insertScheduleSql, season.Id, schedule.FromDayOfWeek, schedule.FromHour, schedule.ToDayOfWeek, schedule.ToHour)
			if err != nil {
				return tariff, fmt.Errorf("error inserting schedule for tariff %s: %w", name, err)
			}
			scheduleId, err := res.LastInsertId()
			if err != nil {
				return tariff, fmt.Errorf("error getting season id for tariff %s: %w", season.Name, err)
			}
			schedule.Id = int(scheduleId)
		}
	}
	tariff.Seasons = seasons

	return tariff, nil
}

func getSeasonsFromFleetSiteInfo(tariff *Tariff, fleetSiteInfo *fleetapi.EnergySiteInfo) ([]TariffSeason, error) {
	result := []TariffSeason{}

	// find tariff seasons and their schedules
	for season_name, season := range fleetSiteInfo.TariffContentV2.Seasons {
		ts := TariffSeason{
			TariffId:  tariff.Id,
			Name:      season_name,
			FromMonth: season.FromMonth,
			FromDay:   season.FromDay,
			ToMonth:   season.ToMonth,
			ToDay:     season.ToDay,
		}

		rate, err := findEnergyChargeRate(tariff.Name, season_name, fleetSiteInfo.TariffContentV2.EnergyCharges)
		if err != nil {
			return nil, fmt.Errorf("error finding buy rate for season %s: %w", season_name, err)
		}
		ts.BuyRate = rate

		rate, err = findEnergyChargeRate(tariff.Name, season_name, fleetSiteInfo.TariffContentV2.SellTariff.EnergyCharges)
		if err != nil {
			return nil, fmt.Errorf("error finding sell rate for season %s: %w", season_name, err)
		}
		ts.SellRate = rate

		for season_tariff_name, periods := range season.TouPeriods {
			if tariff.Name != season_tariff_name {
				continue
			}

			schedules := []TariffSchedule{}
			for _, period := range periods.Periods {
				s := TariffSchedule{
					SeasonId:      ts.Id,
					FromDayOfWeek: period.FromDayOfWeek,
					FromHour:      period.FromHour,
					ToDayOfWeek:   period.ToDayOfWeek,
					ToHour:        period.ToHour,
				}
				schedules = append(schedules, s)
			}
			ts.Schedules = schedules
		}

		result = append(result, ts)
	}

	return result, nil
}

func findEnergyChargeRate(tariff_name string, season_name string, fleetEnergyCharges map[string]fleetapi.EnergyChargeRates) (float64, error) {
	season, ok := fleetEnergyCharges[season_name]
	if !ok {
		return 0, fmt.Errorf("season %s was not found", season_name)
	}

	rate, ok := season.Rates[tariff_name]
	if !ok {
		return 0, fmt.Errorf("tariff %s was not found", tariff_name)
	}

	return rate, nil
}
