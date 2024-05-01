package fleetapi

import (
	"fmt"
	"log/slog"
)

type EnergySiteLiveStatus struct {
	SolarPower         float64 `json:"solar_power"`
	PercentageCharged  float64 `json:"percentage_charged"`
	BackupCapable      bool    `json:"backup_capable"`
	BatteryPower       float64 `json:"battery_power"`
	LoadPower          float64 `json:"load_power"`
	GridStatus         string  `json:"grid_status"`
	GridServicesActive bool    `json:"grid_services_active"`
	GridPower          float64 `json:"grid_power"`
	GridServicesPower  float64 `json:"grid_services_power"`
	GeneratorPower     float64 `json:"generator_power"`
	IslandStatus       string  `json:"island_status"`
	StormModeActive    bool    `json:"storm_mode_active"`
	Timestamp          string  `json:"timestamp"`
	WallConnectors     []any   `json:"wall_connectors"`
}

type EnergySiteLiveStatusResult struct {
	Response EnergySiteLiveStatus `json:"response"`
}

func getEnergySiteLiveUrl(siteId string) (string, string) {
	url := fmt.Sprintf("/api/1/energy_sites/%s/live_status", siteId)
	return url, ""
}

func (c Client) GetEnergySiteLiveStatus(siteId string) (*EnergySiteLiveStatus, error) {
	url, query := getEnergySiteLiveUrl(siteId)
	c.logger.Debug("GetEnergySiteLiveStatus", slog.String("siteid", siteId), slog.String("url", url))
	result, err := getOne[EnergySiteLiveStatusResult](c.getClient(), url, query)
	if err != nil {
		return nil, fmt.Errorf("error getting energy history: %w", err)
	}
	return &result.Response, nil
}
