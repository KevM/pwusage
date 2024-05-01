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

func (b *BatteryHold) StopHold(siteid string) error {
	var batteryReserveBeforeHold int
	var batterySoeAtHold int
	err := b.db.QueryRow("SELECT battery_reserve_before_hold, battery_soe_at_hold FROM BatteryHold WHERE site_id = ?", siteid).Scan(&batteryReserveBeforeHold, &batterySoeAtHold)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("no battery hold record found for siteid: %s", siteid)
		}
		return fmt.Errorf("error querying battery hold record: %w", err)
	}

	b.logger.Debug("Battery hold state", slog.Int("reserve_before_hold", batteryReserveBeforeHold), slog.Int("battery_precent_at_hold", batterySoeAtHold))

	tx, err := b.db.Begin()
	if err != nil {
		return fmt.Errorf("error beginning transaction: %w", err)
	}

	// insert into BatteryReserve table
	_, err = tx.Exec("DELETE FROM BatteryHold WHERE site_id = ?", siteid)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("error removing siteid entry from battery hold table: %w", err)
	}

	err = b.client.SetBatteryReserve(siteid, batterySoeAtHold)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("error restoring battery reserve: %w", err)
	}

	err = tx.Commit()
	if err != nil {
		return fmt.Errorf("error committing transaction: %w", err)
	}
	b.logger.Info("Battery hold ended", slog.Int("percent", batterySoeAtHold))
	return nil
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
		return fmt.Errorf("error inserting into battery hold table: %w", err)
	}

	err = b.client.SetBatteryReserve(siteid, currentlyAt)
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
