package monitor

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gocarina/gocsv"
	"go.uber.org/zap"
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

type PowerwallPoller struct {
	BaseUri  string
	Interval time.Duration
	Logger   *zap.Logger
}

func NewPowerwallPoller(hostPort string, interval time.Duration, logger *zap.Logger) *PowerwallPoller {
	return &PowerwallPoller{
		BaseUri:  hostPort,
		Interval: interval,
		Logger:   logger,
	}
}

func (p *PowerwallPoller) Poll() <-chan PwApi {
	first := true
	out := make(chan PwApi, 10)
	aggUri := fmt.Sprintf("%s/api/meters/aggregates", p.BaseUri)
	csvUri := fmt.Sprintf("%s/csv", p.BaseUri)

	go func() {
		for {
			if !first {
				time.Sleep(p.Interval)
			}

			// Aggregates
			resp, err := http.Get(aggUri)
			if err != nil {
				p.Logger.Error("Error making aggregates HTTP request", zap.Error(err))
				time.Sleep(p.Interval)
				continue
			}

			var a PwAggregates
			err = json.NewDecoder(resp.Body).Decode(&a)
			resp.Body.Close()
			if err != nil {
				p.Logger.Error("Error decoding aggregates JSON response", zap.Error(err))
			}

			// Csv
			resp, err = http.Get(csvUri)
			if err != nil {
				p.Logger.Error("Error making csv HTTP request", zap.Error(err))
				time.Sleep(p.Interval)
				continue
			}

			bodyBytes, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				p.Logger.Error("Error reading CSV HTTP response", zap.Error(err))
				continue
			}
			bodyString := "field1,field2,field3,field4,field5\n" + string(bodyBytes)
			csvStructs := []*PwCsv{}

			if err := gocsv.UnmarshalString(bodyString, &csvStructs); err != nil {
				p.Logger.Error("Error decoding CSV HTTP response", zap.Error(err))
				continue
			}

			// for _, row := range csvStructs {
			// 	p.Logger.Info("CSV", zap.Any("item", row))
			// }

			out <- PwApi{
				Csv:        *csvStructs[0],
				Aggregates: a,
			}
			first = false
		}
	}()

	return out
}
