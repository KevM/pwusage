package main

import (
	"fmt"
	"time"
)

type EnergyData struct {
	Timestamp    time.Time
	LoadPower    float64
	SolarPower   float64
	GridPower    float64
	BatteryPower float64
}

type EnergyRepo struct {
	db *Database
}

func NewEnergyRepo(db *Database) *EnergyRepo {
	return &EnergyRepo{db: db}
}

func (r EnergyRepo) GetEnergies(start time.Time, end time.Time) ([]EnergyData, error) {
	sql := `SELECT timestamp, load_power, solar_power, grid_power, battery_power 
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
		err := rows.Scan(&e.Timestamp, &e.LoadPower, &e.SolarPower, &e.GridPower, &e.BatteryPower)
		if err != nil {
			return nil, err
		}
		results = append(results, e)
	}

	return results, nil
}
