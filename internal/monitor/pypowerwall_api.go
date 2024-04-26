package monitor

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/gocarina/gocsv"
)

type PwApi struct {
	Csv        PwCsv
	Aggregates PwAggregates
}

type PwCsv struct {
	Grid    float64 `csv:"field1"`
	Home    float64 `csv:"field2"`
	Solar   float64 `csv:"field3"`
	Battery float64 `csv:"field4"`
	SOC     float64 `csv:"field5"`
}

type PwAggregates struct {
	Site struct {
		LastCommunicationTime             time.Time `json:"last_communication_time"`
		InstantPower                      float64   `json:"instant_power"`
		InstantReactivePower              float64   `json:"instant_reactive_power"`
		InstantApparentPower              float64   `json:"instant_apparent_power"`
		Frequency                         int       `json:"frequency"`
		EnergyExported                    float64   `json:"energy_exported"`
		EnergyImported                    float64   `json:"energy_imported"`
		LastPhaseVoltageCommunicationTime time.Time `json:"last_phase_voltage_communication_time"`
		LastPhasePowerCommunicationTime   time.Time `json:"last_phase_power_communication_time"`
		LastPhaseEnergyCommunicationTime  time.Time `json:"last_phase_energy_communication_time"`
		Timeout                           int       `json:"timeout"`
		NumMetersAggregated               int       `json:"num_meters_aggregated"`
		InstantTotalCurrent               float64   `json:"instant_total_current"`
	} `json:"site"`
	Battery struct {
		LastCommunicationTime             time.Time `json:"last_communication_time"`
		InstantPower                      float64   `json:"instant_power"`
		InstantReactivePower              float64   `json:"instant_reactive_power"`
		InstantApparentPower              float64   `json:"instant_apparent_power"`
		Frequency                         float64   `json:"frequency"`
		EnergyExported                    int       `json:"energy_exported"`
		EnergyImported                    int       `json:"energy_imported"`
		LastPhaseVoltageCommunicationTime time.Time `json:"last_phase_voltage_communication_time"`
		LastPhasePowerCommunicationTime   time.Time `json:"last_phase_power_communication_time"`
		LastPhaseEnergyCommunicationTime  time.Time `json:"last_phase_energy_communication_time"`
		Timeout                           int       `json:"timeout"`
		NumMetersAggregated               int       `json:"num_meters_aggregated"`
		InstantTotalCurrent               float64   `json:"instant_total_current"`
	} `json:"battery"`
	Load struct {
		LastCommunicationTime             time.Time `json:"last_communication_time"`
		InstantPower                      float64   `json:"instant_power"`
		InstantReactivePower              float64   `json:"instant_reactive_power"`
		InstantApparentPower              float64   `json:"instant_apparent_power"`
		Frequency                         int       `json:"frequency"`
		EnergyExported                    int       `json:"energy_exported"`
		EnergyImported                    float64   `json:"energy_imported"`
		LastPhaseVoltageCommunicationTime time.Time `json:"last_phase_voltage_communication_time"`
		LastPhasePowerCommunicationTime   time.Time `json:"last_phase_power_communication_time"`
		LastPhaseEnergyCommunicationTime  time.Time `json:"last_phase_energy_communication_time"`
		Timeout                           int       `json:"timeout"`
		InstantTotalCurrent               float64   `json:"instant_total_current"`
	} `json:"load"`
	Solar struct {
		LastCommunicationTime             time.Time `json:"last_communication_time"`
		InstantPower                      float64   `json:"instant_power"`
		InstantReactivePower              float64   `json:"instant_reactive_power"`
		InstantApparentPower              float64   `json:"instant_apparent_power"`
		Frequency                         int       `json:"frequency"`
		EnergyExported                    float64   `json:"energy_exported"`
		EnergyImported                    float64   `json:"energy_imported"`
		LastPhaseVoltageCommunicationTime time.Time `json:"last_phase_voltage_communication_time"`
		LastPhasePowerCommunicationTime   time.Time `json:"last_phase_power_communication_time"`
		LastPhaseEnergyCommunicationTime  time.Time `json:"last_phase_energy_communication_time"`
		Timeout                           int       `json:"timeout"`
		NumMetersAggregated               int       `json:"num_meters_aggregated"`
		InstantTotalCurrent               float64   `json:"instant_total_current"`
	} `json:"solar"`
}

type PowerwallApi struct {
	BaseUri string
	Logger  *slog.Logger
}

func NewPowerwallApi(hostPort string, logger *slog.Logger) *PowerwallApi {
	return &PowerwallApi{
		BaseUri: hostPort,
		Logger:  logger,
	}
}

func (p *PowerwallApi) GetPwApi() (PwApi, error) {

	var result PwApi

	aggregates, err := p.GetAggregates()
	if err != nil {
		return result, err
	}

	csv, err := p.GetCsv()
	if err != nil {
		return result, err
	}

	return PwApi{
		Csv:        csv,
		Aggregates: aggregates,
	}, nil
}

func (p *PowerwallApi) GetAggregates() (PwAggregates, error) {
	uri := fmt.Sprintf("%s/api/meters/aggregates", p.BaseUri)
	var result PwAggregates

	resp, err := http.Get(uri)
	if err != nil {
		p.Logger.Error("Error making aggregates HTTP request", slog.Any("error", err))
		return result, err
	}

	err = json.NewDecoder(resp.Body).Decode(&result)
	resp.Body.Close()
	if err != nil {
		p.Logger.Error("Error decoding aggregates JSON response", slog.Any("error", err))
		return result, err
	}

	return result, nil
}

func (p *PowerwallApi) GetCsv() (PwCsv, error) {
	uri := fmt.Sprintf("%s/csv", p.BaseUri)
	var result PwCsv

	resp, err := http.Get(uri)
	if err != nil {
		p.Logger.Error("Error making csv HTTP request", slog.Any("error", err))
		return result, err
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		p.Logger.Error("Error reading csv HTTP response", slog.Any("error", err))
		return result, err
	}
	bodyString := "field1,field2,field3,field4,field5\n" + string(bodyBytes) // result doesn't have header so we add one.
	csvStructs := []*PwCsv{}

	if err := gocsv.UnmarshalString(bodyString, &csvStructs); err != nil {
		p.Logger.Error("Error decoding csv HTTP response", slog.Any("error", err))
		return result, err
	}

	result = *csvStructs[0]
	return result, nil
}

func (p *PowerwallApi) PollApi(interval time.Duration) <-chan PwApi {
	first := true
	out := make(chan PwApi, 10)

	go func() {
		for {
			if !first {
				time.Sleep(interval)
			}

			api, err := p.GetPwApi()
			if err != nil {
				p.Logger.Error("Error getting Powerwall API", slog.Any("error", err))
				continue
			}

			out <- api
			first = false
		}
	}()

	return out
}
