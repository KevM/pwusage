package fleetapi

import (
	"fmt"
	"log/slog"
)

type FleetProduct struct {
	EnergySiteID                       int64  `json:"energy_site_id"`
	ResourceType                       string `json:"resource_type"`
	SiteName                           string `json:"site_name"`
	ID                                 string `json:"id"`
	GatewayID                          string `json:"gateway_id"`
	AssetSiteID                        string `json:"asset_site_id"`
	WarpSiteNumber                     string `json:"warp_site_number"`
	PercentageCharged                  int    `json:"percentage_charged"`
	BatteryType                        string `json:"battery_type"`
	BackupCapable                      bool   `json:"backup_capable"`
	BatteryPower                       int    `json:"battery_power"`
	GoOffGridTestBannerEnabled         any    `json:"go_off_grid_test_banner_enabled"`
	StormModeEnabled                   bool   `json:"storm_mode_enabled"`
	PowerwallOnboardingSettingsSet     bool   `json:"powerwall_onboarding_settings_set"`
	PowerwallTeslaElectricInterestedIn any    `json:"powerwall_tesla_electric_interested_in"`
	VppTourEnabled                     any    `json:"vpp_tour_enabled"`
	SyncGridAlertEnabled               bool   `json:"sync_grid_alert_enabled"`
	BreakerAlertEnabled                bool   `json:"breaker_alert_enabled"`
	Components                         struct {
		Battery     bool   `json:"battery"`
		BatteryType string `json:"battery_type"`
		Solar       bool   `json:"solar"`
		SolarType   string `json:"solar_type"`
		Grid        bool   `json:"grid"`
		LoadMeter   bool   `json:"load_meter"`
		MarketType  string `json:"market_type"`
	} `json:"components"`
	Features struct {
		RatePlanManagerNoPricingConstraint bool `json:"rate_plan_manager_no_pricing_constraint"`
	} `json:"features"`
}

type GetProductResult struct {
	Response []FleetProduct `json:"response"`
	Count    int            `json:"count"`
}

func (c FleetApiClient) GetProducts() ([]FleetProduct, error) {
	url := "/api/1/products"
	c.logger.Debug("GetProducts", slog.String("url", url))
	result, err := getOne[GetProductResult](c.getClient(), url, "")
	if err != nil {
		return nil, fmt.Errorf("error getting energy history: %w", err)
	}
	r := result.Response
	return r, nil
}
