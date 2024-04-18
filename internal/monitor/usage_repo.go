package monitor

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

type Usage_Repo struct {
	pb *pocketbase.PocketBase
}

func NewUsageRepo(pb *pocketbase.PocketBase) *Usage_Repo {
	return &Usage_Repo{pb: pb}
}

func (repo *Usage_Repo) GetUsageSamples(tp TariffPeriod) (*models.Record, *models.Record, error) {
	dao := repo.pb.Dao()

	startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05")
	filter := "tariff = {:tariff} && created >= {:start}"
	params := dbx.Params{"start": startS, "tariff": tp.Tariff}
	records, err := dao.FindRecordsByFilter("sample", filter, "created", 1, 0, params)
	repo.pb.Logger().Debug("get usage start sample", slog.String("filter", filter), slog.Any("params", params))
	if err != nil {
		return nil, nil, fmt.Errorf("error finding start sample record: %w", err)
	}
	if len(records) < 1 {
		return nil, nil, fmt.Errorf("did not find start sample record")
	}
	start := records[0]

	endS := tp.End.In(time.UTC).Format("2006-01-02 15:04:05")
	filter = "tariff = {:tariff} && created < {:end}"
	params = dbx.Params{"end": endS, "tariff": tp.Tariff}
	records, err = dao.FindRecordsByFilter("sample", filter, "-created", 1, 0, params)
	repo.pb.Logger().Debug("get usage end sample", slog.String("filter", filter), slog.Any("params", params))
	if err != nil {
		return nil, nil, fmt.Errorf("error finding end sample record: %w", err)
	}
	if len(records) < 1 {
		return nil, nil, fmt.Errorf("did not find end sample record")
	}
	end := records[0]

	return start, end, nil
}

func (repo *Usage_Repo) CreateUsageRecord(ur *models.Record, tp TariffPeriod, start *models.Record, end *models.Record) *models.Record {
	dao := repo.pb.Dao()
	collection, err := dao.FindCollectionByNameOrId("usage")
	if err != nil {
		repo.pb.Logger().Error("Sampler: error finding sample collection", slog.Any("error", err))
	}

	//usage = start - end
	homeUsage := end.Get("home_usage").(float64) - start.Get("home_usage").(float64)
	solarProduction := end.Get("solar_production").(float64) - start.Get("solar_production").(float64)
	gridImported := end.Get("grid_imported").(float64) - start.Get("grid_imported").(float64)
	gridExported := end.Get("grid_exported").(float64) - start.Get("grid_exported").(float64)

	if ur == nil {
		ur = models.NewRecord(collection)
	}
	ur.Set("tariff", tp.Tariff)
	ur.Set("start", tp.Start)
	ur.Set("end", tp.End)
	ur.Set("home_usage", homeUsage)
	ur.Set("solar_production", solarProduction)
	ur.Set("grid_imported", gridImported)
	ur.Set("grid_exported", gridExported)

	repo.pb.Logger().Info("Created usage record", slog.Any("start", start), slog.Any("end", end), slog.Any("usage", ur))
	return ur
}

func (repo *Usage_Repo) GetUsagesBetween(s time.Time, e time.Time) ([]*models.Record, error) {
	startS := s.In(time.UTC).Format("2006-01-02 15:04:05.000")
	endS := e.In(time.UTC).Add(1 * time.Millisecond).Format("2006-01-02 15:04:05.000")
	filter := "start >= {:start} && end <= {:end}"
	params := dbx.Params{"start": startS, "end": endS}
	repo.pb.Logger().Debug("Getting usages", slog.String("start", startS), slog.String("end", endS))
	usages, err := repo.pb.Dao().FindRecordsByFilter("usage", filter, "start", -1, 0, params)
	if err != nil {
		return nil, fmt.Errorf("error getting usages from %s to %s: %w", startS, endS, err)
	}

	return usages, nil
}

func (repo *Usage_Repo) GetTariffPeriodUsages(tp TariffPeriod) (*models.Record, error) {
	startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05.000")
	endS := tp.End.In(time.UTC).Add(1 * time.Millisecond).Format("2006-01-02 15:04:05.000")
	filter := "tariff = {:tariff} && start >= {:start} && end <= {:end}"
	params := dbx.Params{"tariff": tp.Tariff, "start": startS, "end": endS}
	repo.pb.Logger().Debug("Getting usages", slog.String("start", startS), slog.String("end", endS))
	usages, err := repo.pb.Dao().FindRecordsByFilter("usage", filter, "start", -1, 0, params)
	if err != nil {
		return nil, fmt.Errorf("error getting usages from %s to %s: %w", startS, endS, err)
	}

	if len(usages) > 1 {
		return nil, fmt.Errorf("found more than one usage record for tariff period %s", tp)
	}

	if len(usages) == 1 {
		return usages[0], nil
	}

	return nil, nil
}
