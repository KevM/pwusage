package fleetdb

import (
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/kevm/pw-usage/internal/fleetapi"
)

type BatteryHold struct {
	client *fleetapi.Client
	db     *Database
	logger *slog.Logger
}

func NewBatteryHold(db *Database, client *fleetapi.Client, logger *slog.Logger) *BatteryHold {
	return &BatteryHold{
		client: client,
		db:     db,
		logger: logger,
	}
}

type BatteryHoldState struct {
	Started               time.Time
	StartBatteryCharge    int
	BatteryReserveAtStart int
}

func (b *BatteryHold) CalculateHold(siteid string) (*BatteryHoldState, error) {
	info, err := b.client.GetEnergySiteInfo(siteid)
	if err != nil {
		return nil, fmt.Errorf("error getting energy site info: %w", err)
	}

	live, err := b.client.GetEnergySiteLiveStatus(siteid)
	if err != nil {
		return nil, fmt.Errorf("error getting energy site live status: %w", err)
	}

	reserveSetting := 100 - info.BackupReservePercent
	currentlyAt := int(live.PercentageCharged)
	b.logger.Debug("Battery Details", slog.Int("currently", currentlyAt), slog.Int("reserve", reserveSetting))

	return &BatteryHoldState{
		Started:               time.Now(),
		StartBatteryCharge:    int(live.PercentageCharged),
		BatteryReserveAtStart: info.BackupReservePercent,
	}, nil
}

func (b *BatteryHold) FindSiteHold(siteid string) (*BatteryHoldState, error) {
	var started time.Time
	var batteryReserveBeforeHold int
	var batterySoeAtHold int

	err := b.db.Conn().
		QueryRow("SELECT created, battery_reserve_before_hold, battery_soe_at_hold FROM BatteryHold WHERE site_id = ?", siteid).
		Scan(&started, &batteryReserveBeforeHold, &batterySoeAtHold)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("error querying battery hold record: %w", err)
	}

	b.logger.Debug("Battery hold state", slog.Int("reserve_before_hold", batteryReserveBeforeHold), slog.Int("battery_precent_at_hold", batterySoeAtHold))

	return &BatteryHoldState{
		Started:               started,
		StartBatteryCharge:    batterySoeAtHold,
		BatteryReserveAtStart: batteryReserveBeforeHold,
	}, nil
}

func (b *BatteryHold) StopHold(siteid string) error {
	var batteryReserveBeforeHold int
	var batterySoeAtHold int
	err := b.db.Conn().QueryRow("SELECT battery_reserve_before_hold, battery_soe_at_hold FROM BatteryHold WHERE site_id = ?", siteid).Scan(&batteryReserveBeforeHold, &batterySoeAtHold)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("no battery hold record found for siteid: %s", siteid)
		}
		return fmt.Errorf("error querying battery hold record: %w", err)
	}

	b.logger.Debug("Battery hold state", slog.Int("reserve_before_hold", batteryReserveBeforeHold), slog.Int("battery_precent_at_hold", batterySoeAtHold))

	tx, err := b.db.Conn().Begin()
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

func (b *BatteryHold) StartHold(siteid string) (*BatteryHoldState, error) {

	hold, err := b.CalculateHold(siteid)
	if err != nil {
		return nil, fmt.Errorf("error calculating hold settings: %w", err)
	}

	tx, err := b.db.Conn().Begin()
	if err != nil {
		return nil, fmt.Errorf("error beginning transaction: %w", err)
	}

	// insert into BatteryReserve table
	_, err = tx.Exec("INSERT INTO BatteryHold (site_id, battery_reserve_before_hold, battery_soe_at_hold) VALUES (?, ?, ?)", siteid, hold.BatteryReserveAtStart, hold.StartBatteryCharge)
	if err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("error inserting into battery hold table: %w", err)
	}

	err = b.client.SetBatteryReserve(siteid, hold.StartBatteryCharge)
	if err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("error setting battery reserve: %w", err)
	}

	err = tx.Commit()
	if err != nil {
		return nil, fmt.Errorf("error committing transaction: %w", err)
	}
	b.logger.Info("Holding battery at current level. Reserve set to match current battery charge.", slog.Int("percent", hold.StartBatteryCharge))

	result, err := b.FindSiteHold(siteid)
	if err != nil {
		return nil, fmt.Errorf("error getting hold record: %w", err)
	}

	return result, nil
}
