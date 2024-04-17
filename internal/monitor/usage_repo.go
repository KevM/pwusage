package monitor

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/neomantra/ymdflag"
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
	startS := tp.Start.In(time.UTC).Format("2006-01-02 15:04:05")
	endS := tp.End.In(time.UTC).Format("2006-01-02 15:04:05")
	filter := "tariff = {:tariff} && created >= {:start} && created < {:end}"
	params := dbx.Params{"start": startS, "end": endS, "tariff": tp.Tariff}

	dao := repo.pb.Dao()
	records, err := dao.FindRecordsByFilter("sample", filter, "created", -1, 0, params)
	repo.pb.Logger().Debug("get usage samples", slog.String("filter", filter), slog.Any("params", params))
	if err != nil {
		return nil, nil, fmt.Errorf("error finding sample records for usage creation: %w", err)
	}

	if len(records) < 2 {
		return nil, nil, fmt.Errorf("not enough sample records to create usage record")
	}

	start := records[0]
	end := records[len(records)-1]

	return start, end, nil
}

func (repo *Usage_Repo) CreateUsageRecord(tp TariffPeriod, start *models.Record, end *models.Record) *models.Record {
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

	ur := models.NewRecord(collection)
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

func (repo *Usage_Repo) GetUsagesBetween(start ymdflag.YMDFlag, end ymdflag.YMDFlag, location *time.Location) ([]*models.Record, error) {
	s := start.AsTimeWithLoc(location).In(time.UTC)
	e := end.AsTimeWithLoc(location).In(time.UTC)
	startS := s.Format("2006-01-02 15:04:05")
	endS := e.Format("2006-01-02 15:04:05")
	filter := "start >= {:start} && end <= {:end}"
	params := dbx.Params{"start": startS, "end": endS}
	repo.pb.Logger().Debug("Getting usage report", slog.String("start", startS), slog.String("end", endS))
	usages, err := repo.pb.Dao().FindRecordsByFilter("usage", filter, "start", -1, 0, params)
	if err != nil {
		return nil, fmt.Errorf("error getting usages from %s to %s: %w", startS, endS, err)
	}

	return usages, nil
}
