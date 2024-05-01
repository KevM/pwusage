package main

import (
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type BatteryHold struct {
	client *fleetapi.FleetApiClient
	db     *sql.DB
	logger *slog.Logger
}

func NewBatteryHold(db *sql.DB, token string, logger *slog.Logger) *BatteryHold {
	client := fleetapi.NewFleetApiClient(token, logger)

	return &BatteryHold{
		client: client,
		db:     db,
		logger: logger,
	}
}

func (b *BatteryHold) StartHold(siteid string) error {

	info, err := b.client.GetEnergySiteInfo(siteid)
	if err != nil {
		return fmt.Errorf("error getting energy site info: %w", err)
	}

	live, err := b.client.GetEnergySiteLiveStatus(siteid)
	if err != nil {
		return fmt.Errorf("error getting energy site live status: %w", err)
	}

	reserveSetting := info.BackupReservePercent
	currentlyAt := int(live.PercentageCharged)
	b.logger.Debug("Battery Details", slog.Int("currently", currentlyAt), slog.Int("reserve", reserveSetting))

	tx, err := b.db.Begin()
	if err != nil {
		return fmt.Errorf("error beginning transaction: %w", err)
	}

	// insert into BatteryReserve table
	_, err = tx.Exec("INSERT INTO BatteryHold (site_id, battery_reserve_before_hold, battery_soe_at_hold) VALUES (?, ?, ?)", siteid, reserveSetting, currentlyAt)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("error inserting into BatteryReserve table: %w", err)
	}

	err = b.client.SetBatteryReserve(siteid, int64(currentlyAt))
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("error setting battery reserve: %w", err)
	}

	err = tx.Commit()
	if err != nil {
		return fmt.Errorf("error committing transaction: %w", err)
	}
	b.logger.Info("Holding battery", slog.Int("percent", currentlyAt))

	return nil
}
