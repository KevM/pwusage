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

type Sample_Repo struct {
	pb *pocketbase.PocketBase
}

func NewSampleRepo(pb *pocketbase.PocketBase) *Sample_Repo {
	return &Sample_Repo{pb: pb}
}

func (repo *Sample_Repo) GetLastTariffPeriodSample(tp TariffPeriod) (*models.Record, error) {
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
	return r, nil
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

type Backfill struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

func (repo *Sample_Repo) GetSampleGaps(start ymdflag.YMDFlag, end ymdflag.YMDFlag, gaplimit time.Duration) ([]Backfill, error) {
	s := start.AsTimeWithLoc(time.UTC).Format("2006-01-02 15:04:05.000")
	e := end.AsTimeWithLoc(time.UTC).Add(1 * time.Millisecond).Format("2006-01-02 15:04:05.000")

	type Result struct {
		Created string `db:"created" json:"created"`
	}

	samples := []Result{}
	err := repo.pb.Dao().DB().
		NewQuery("SELECT created FROM sample WHERE created >= {:from} and created <= {:to}").
		Bind(dbx.Params{"from": s, "to": e}).All(&samples)
	if err != nil {
		return nil, err
	}

	// get sample gaps between start and end
	results := []Backfill{}
	if len(samples) < 1 {
		results = append(results, Backfill{Start: start.AsTimeWithLoc(time.UTC), End: end.AsTimeWithLoc(time.UTC)})
		return results, nil
	}

	var prev *time.Time = nil
	for _, r := range samples {
		created, err := time.Parse("2006-01-02 15:04:05.999Z", r.Created)
		if err != nil {
			return nil, err
		}

		if prev == nil {
			if created.Sub(start.AsTimeWithLoc(time.UTC)) > gaplimit {
				b := Backfill{
					Start: start.AsTimeWithLoc(time.UTC),
					End:   created.Add(-1 * time.Second),
				}
				results = append(results, b)
			}
			prev = &created
			continue
		}

		gap := created.Sub(*prev)
		if gap > gaplimit {
			results = append(results, Backfill{Start: prev.Add(1 * time.Second), End: created.Add(-1 * time.Second)})
		}
		prev = &created
	}

	if end.AsTimeWithLoc(time.UTC).Sub(*prev) > gaplimit {
		results = append(results, Backfill{Start: prev.Add(1 * time.Second), End: end.AsTimeWithLoc(time.UTC)})
	}

	return results, nil
}
