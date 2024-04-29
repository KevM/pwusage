package fleetapi

import (
	"fmt"
	"log/slog"
	"time"
)

type EnergyHistoryEntry struct {
	Timestamp                           time.Time `json:"timestamp,omitempty"`
	SolarEnergyExported                 float64   `json:"solar_energy_exported,omitempty"`
	GeneratorEnergyExported             float64   `json:"generator_energy_exported,omitempty"`
	GridEnergyImported                  float64   `json:"grid_energy_imported,omitempty"`
	GridServicesEnergyImported          float64   `json:"grid_services_energy_imported,omitempty"`
	GridServicesEnergyExported          float64   `json:"grid_services_energy_exported,omitempty"`
	GridEnergyExportedFromSolar         float64   `json:"grid_energy_exported_from_solar,omitempty"`
	GridEnergyExportedFromGenerator     float64   `json:"grid_energy_exported_from_generator,omitempty"`
	GridEnergyExportedFromBattery       float64   `json:"grid_energy_exported_from_battery,omitempty"`
	BatteryEnergyExported               float64   `json:"battery_energy_exported,omitempty"`
	BatteryEnergyImportedFromGrid       float64   `json:"battery_energy_imported_from_grid,omitempty"`
	BatteryEnergyImportedFromSolar      float64   `json:"battery_energy_imported_from_solar,omitempty"`
	BatteryEnergyImportedFromGenerator  float64   `json:"battery_energy_imported_from_generator,omitempty"`
	ConsumerEnergyImportedFromGrid      float64   `json:"consumer_energy_imported_from_grid,omitempty"`
	ConsumerEnergyImportedFromSolar     float64   `json:"consumer_energy_imported_from_solar,omitempty"`
	ConsumerEnergyImportedFromBattery   float64   `json:"consumer_energy_imported_from_battery,omitempty"`
	ConsumerEnergyImportedFromGenerator float64   `json:"consumer_energy_imported_from_generator,omitempty"`
	RawTimestamp                        time.Time `json:"raw_timestamp,omitempty"`
	TotalHomeUsage                      float64   `json:"total_home_usage,omitempty"`
	TotalSolarGeneration                float64   `json:"total_solar_generation,omitempty"`
	TotalBatteryCharge                  float64   `json:"total_battery_charge,omitempty"`
	TotalBatteryDischarge               float64   `json:"total_battery_discharge,omitempty"`
	TotalGridEnergyExported             float64   `json:"total_grid_energy_exported,omitempty"`
}

type EnergyHistoryResult struct {
	Response struct {
		SerialNumber         string               `json:"serial_number,omitempty"`
		Period               string               `json:"period,omitempty"`
		InstallationTimeZone string               `json:"installation_time_zone,omitempty"`
		TimeSeries           []EnergyHistoryEntry `json:"time_series"`
	}
}

func getEnergyHistoryUrl(siteId string, start time.Time, end time.Time, period string, tz *time.Location) (string, string) {
	url := fmt.Sprintf("/api/1/energy_sites/%s/calendar_history", siteId)

	s := start.In(tz).Format("2006-01-02T15:04:05-07:00")
	e := end.In(tz).Format("2006-01-02T15:04:05-07:00")
	query := fmt.Sprintf("kind=energy&start_date=%s&end_date=%s&period=%s&time_zone=%s", s, e, period, tz.String())

	return url, query
}

func (c FleetApiClient) GetEnergyHistory(siteId string, start time.Time, end time.Time, period string, tz *time.Location) ([]EnergyHistoryEntry, error) {
	url, query := getEnergyHistoryUrl(siteId, start, end, period, tz)
	c.logger.Debug("GetEnergyHistory", slog.String("url", url), slog.String("query", query))
	result, err := getOne[EnergyHistoryResult](c.getClient(), url, query)
	if err != nil {
		return nil, fmt.Errorf("error getting energy history: %w", err)
	}
	return result.Response.TimeSeries, nil
}
