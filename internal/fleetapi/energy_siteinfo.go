package fleetapi

import (
	"fmt"
	"log/slog"
	"time"
)

type EnergySiteInfo struct {
	ID                   string    `json:"id,omitempty"`
	SiteName             string    `json:"site_name,omitempty"`
	BackupReservePercent int       `json:"backup_reserve_percent,omitempty"`
	DefaultRealMode      string    `json:"default_real_mode,omitempty"`
	InstallationDate     time.Time `json:"installation_date,omitempty"`
	UserSettings         struct {
		GoOffGridTestBannerEnabled         bool `json:"go_off_grid_test_banner_enabled,omitempty"`
		StormModeEnabled                   bool `json:"storm_mode_enabled,omitempty"`
		PowerwallOnboardingSettingsSet     bool `json:"powerwall_onboarding_settings_set,omitempty"`
		PowerwallTeslaElectricInterestedIn bool `json:"powerwall_tesla_electric_interested_in,omitempty"`
		VppTourEnabled                     bool `json:"vpp_tour_enabled,omitempty"`
		SyncGridAlertEnabled               bool `json:"sync_grid_alert_enabled,omitempty"`
		BreakerAlertEnabled                bool `json:"breaker_alert_enabled,omitempty"`
	} `json:"user_settings,omitempty"`
	Components struct {
		Solar                                  bool   `json:"solar,omitempty"`
		SolarType                              string `json:"solar_type,omitempty"`
		Battery                                bool   `json:"battery,omitempty"`
		Grid                                   bool   `json:"grid,omitempty"`
		Backup                                 bool   `json:"backup,omitempty"`
		Gateway                                string `json:"gateway,omitempty"`
		LoadMeter                              bool   `json:"load_meter,omitempty"`
		TouCapable                             bool   `json:"tou_capable,omitempty"`
		StormModeCapable                       bool   `json:"storm_mode_capable,omitempty"`
		FlexEnergyRequestCapable               bool   `json:"flex_energy_request_capable,omitempty"`
		CarChargingDataSupported               bool   `json:"car_charging_data_supported,omitempty"`
		OffGridVehicleChargingReserveSupported bool   `json:"off_grid_vehicle_charging_reserve_supported,omitempty"`
		VehicleChargingPerformanceViewEnabled  bool   `json:"vehicle_charging_performance_view_enabled,omitempty"`
		VehicleChargingSolarOffsetViewEnabled  bool   `json:"vehicle_charging_solar_offset_view_enabled,omitempty"`
		BatterySolarOffsetViewEnabled          bool   `json:"battery_solar_offset_view_enabled,omitempty"`
		SolarValueEnabled                      bool   `json:"solar_value_enabled,omitempty"`
		EnergyValueHeader                      string `json:"energy_value_header,omitempty"`
		EnergyValueSubheader                   string `json:"energy_value_subheader,omitempty"`
		EnergyServiceSelfSchedulingEnabled     bool   `json:"energy_service_self_scheduling_enabled,omitempty"`
		ShowGridImportBatterySourceCards       bool   `json:"show_grid_import_battery_source_cards,omitempty"`
		SetIslandingModeEnabled                bool   `json:"set_islanding_mode_enabled,omitempty"`
		WifiCommissioningEnabled               bool   `json:"wifi_commissioning_enabled,omitempty"`
		BackupTimeRemainingEnabled             bool   `json:"backup_time_remaining_enabled,omitempty"`
		BatteryType                            string `json:"battery_type,omitempty"`
		Configurable                           bool   `json:"configurable,omitempty"`
		GridServicesEnabled                    bool   `json:"grid_services_enabled,omitempty"`
		Gateways                               []struct {
			DeviceID        string    `json:"device_id,omitempty"`
			Din             string    `json:"din,omitempty"`
			SerialNumber    string    `json:"serial_number,omitempty"`
			PartNumber      string    `json:"part_number,omitempty"`
			PartType        int       `json:"part_type,omitempty"`
			PartName        string    `json:"part_name,omitempty"`
			IsActive        bool      `json:"is_active,omitempty"`
			SiteID          string    `json:"site_id,omitempty"`
			FirmwareVersion string    `json:"firmware_version,omitempty"`
			UpdatedDatetime time.Time `json:"updated_datetime,omitempty"`
		} `json:"gateways,omitempty"`
		Batteries []struct {
			DeviceID                   string `json:"device_id,omitempty"`
			Din                        string `json:"din,omitempty"`
			SerialNumber               string `json:"serial_number,omitempty"`
			PartNumber                 string `json:"part_number,omitempty"`
			PartType                   int    `json:"part_type,omitempty"`
			PartName                   string `json:"part_name,omitempty"`
			NameplateMaxChargePower    int    `json:"nameplate_max_charge_power,omitempty"`
			NameplateMaxDischargePower int    `json:"nameplate_max_discharge_power,omitempty"`
			NameplateEnergy            int    `json:"nameplate_energy,omitempty"`
		} `json:"batteries,omitempty"`
		NetMeterMode                  string `json:"net_meter_mode,omitempty"`
		EditSettingPermissionToExport bool   `json:"edit_setting_permission_to_export,omitempty"`
		EditSettingGridCharging       bool   `json:"edit_setting_grid_charging,omitempty"`
		EditSettingEnergyExports      bool   `json:"edit_setting_energy_exports,omitempty"`
		SystemAlertsEnabled           bool   `json:"system_alerts_enabled,omitempty"`
	} `json:"components,omitempty"`
	Version                              string      `json:"version,omitempty"`
	BatteryCount                         int         `json:"battery_count,omitempty"`
	TariffContent                        interface{} `json:"tariff_content,omitempty"`
	NameplatePower                       int         `json:"nameplate_power,omitempty"`
	NameplateEnergy                      int         `json:"nameplate_energy,omitempty"`
	InstallationTimeZone                 string      `json:"installation_time_zone,omitempty"`
	OffGridVehicleChargingReservePercent int         `json:"off_grid_vehicle_charging_reserve_percent,omitempty"`
	MaxSiteMeterPowerAc                  int         `json:"max_site_meter_power_ac,omitempty"`
	MinSiteMeterPowerAc                  int         `json:"min_site_meter_power_ac,omitempty"`
	TariffContentV2                      TariffV2    `json:"tariff_content_v2"`
	VppBackupReservePercent              int         `json:"vpp_backup_reserve_percent,omitempty"`
}

type SeasonPeriod struct {
	ToDayOfWeek   *int `json:"toDayOfWeek,omitempty"`
	ToHour        *int `json:"toHour,omitempty"`
	ToMinute      *int `json:"toMinute,omitempty"`
	FromDayOfWeek *int `json:"fromDayOfWeek,omitempty"`
	FromHour      *int `json:"fromHour,omitempty"`
	FromMinute    *int `json:"fromMinute,omitempty"`
}

type SeasonPeriods struct {
	Periods []SeasonPeriod `json:"periods"`
}

type Season struct {
	FromDay    int                      `json:"fromDay"`
	ToDay      int                      `json:"toDay"`
	FromMonth  int                      `json:"fromMonth"`
	ToMonth    int                      `json:"toMonth"`
	TouPeriods map[string]SeasonPeriods `json:"tou_periods"`
}

type EnergyChargeRates struct {
	Rates map[string]float64 `json:"rates"`
}

type TariffV2 struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Utility string `json:"utility"`
	// DailyCharges interface{} `json:"daily_charges"`
	// DemandCharges map[string]interface{}
	// EnergyCharges map[string]map[string]float64
	EnergyCharges map[string]EnergyChargeRates `json:"energy_charges"`
	Seasons       map[string]Season            `json:"seasons"`
	SellTariff    struct {
		Name    string `json:"name"`
		Utility string `json:"utility"`
		// DailyCharges interface{} `json:"daily_charges"`
		// DemandCharges map[string]map[string]float64 `json:"demand_charges"`
		//EnergyCharges map[string]map[string]float64 `json:"energy_charges"`
		EnergyCharges map[string]EnergyChargeRates `json:"energy_charges"`
		Seasons       map[string]Season            `json:"seasons"`
	} `json:"sell_tariff"`
	Version int `json:"version"`
}

type SiteInfoResult struct {
	Response EnergySiteInfo `json:"response,omitempty"`
}

func getEnergySiteInfoUrl(siteId string) (string, string) {
	url := fmt.Sprintf("/api/1/energy_sites/%s/site_info", siteId)
	return url, ""
}

func (c Client) GetEnergySiteInfo(siteId string) (*EnergySiteInfo, error) {
	url, query := getEnergySiteInfoUrl(siteId)
	c.logger.Debug("GetEnergySiteInfo", slog.String("siteid", siteId), slog.String("url", url))
	result, err := getOne[SiteInfoResult](c.getClient(), url, query)
	if err != nil {
		return nil, fmt.Errorf("error getting energy history: %w", err)
	}
	r := result.Response
	return &r, nil
}
