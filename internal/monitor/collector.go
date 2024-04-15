package monitor

import (
	"log/slog"
)

type PwSample struct {
	Grid_exported  float64
	Grid_imported  float64
	Load_imported  float64
	Solar_exported float64
	Battery_SOE    float64
}

type PwCollector struct {
	Logger *slog.Logger

	Samples []PwSample
	Total   struct {
		GridImported    float64
		GridExported    float64
		SolarProduction float64
		HomeConsumption float64
	}
	Immediate struct {
		Home          float64
		Solar         float64
		Grid          float64
		Battery       float64
		StateOfCharge float64
	}
}

func NewPwCollector(logger *slog.Logger) PwCollector {
	return PwCollector{
		Logger: logger,
	}
}

func (c *PwCollector) Collect(r PwApi) PwSample {
	current := PwSample{
		Grid_exported:  r.Aggregates.Site.EnergyExported,
		Grid_imported:  r.Aggregates.Site.EnergyImported,
		Load_imported:  r.Aggregates.Load.EnergyImported,
		Solar_exported: r.Aggregates.Solar.EnergyExported,
		Battery_SOE:    r.Csv.SOC,
	}

	// Compare previous sample with the new one to calculate the production and consumption
	if len(c.Samples) > 0 {
		previous := c.Samples[len(c.Samples)-1]
		c.Total.GridImported += current.Grid_imported - previous.Grid_imported
		c.Total.GridExported += current.Grid_exported - previous.Grid_exported
		c.Total.SolarProduction += current.Solar_exported - previous.Solar_exported
		c.Total.HomeConsumption += current.Load_imported - previous.Load_imported
	}

	c.Immediate.StateOfCharge = r.Csv.SOC
	c.Immediate.Home = r.Csv.Home
	c.Immediate.Solar = r.Csv.Solar
	c.Immediate.Grid = r.Csv.Grid
	c.Immediate.Battery = r.Csv.Battery

	c.Samples = append(c.Samples, current)

	return current
}
