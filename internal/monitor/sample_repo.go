package monitor

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/models"
)

type PwCurrently struct {
	Grid_exported  float64
	Grid_imported  float64
	Load_imported  float64
	Solar_exported float64
	Battery_SOE    float64
	Tariff         string
}

type Sample_Repo struct {
	pb *pocketbase.PocketBase
}

func NewSampleRepo(pb *pocketbase.PocketBase) *Sample_Repo {
	return &Sample_Repo{pb: pb}
}

func (repo *Sample_Repo) GetLastTariffPeriodSample(tp TariffPeriod) (*PwCurrently, error) {
	dao := repo.pb.Dao()
	endS := tp.End.In(time.UTC).Add(-1 * time.Second).Format("2006-01-02 15:04:05")
	filter := "created <= {:end}"
	params := dbx.Params{"end": endS}
	records, err := dao.FindRecordsByFilter("sample", filter, "-created", 1, 0, params)
	repo.pb.Logger().Debug("get usage start sample", slog.String("filter", filter), slog.Any("params", params))
	if err != nil {
		return nil, fmt.Errorf("error finding start sample record: %w", err)
	}
	if len(records) < 1 {
		return nil, fmt.Errorf("did not find sample record before tariff period ending: %s", endS)
	}

	r := records[0]
	result := PwCurrently{
		Grid_exported:  r.GetFloat("grid_exported"),
		Grid_imported:  r.GetFloat("grid_imported"),
		Load_imported:  r.GetFloat("home_usage"),
		Solar_exported: r.GetFloat("solar_production"),
		Battery_SOE:    r.GetFloat("battery_charge"),
		Tariff:         tp.Tariff,
	}

	return &result, nil
}

func (repo *Sample_Repo) GetTarrifPeriodStartAndEndSamples(tp TariffPeriod) (*models.Record, *models.Record, error) {
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
