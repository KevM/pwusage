package fleetdb

type SiteRepo struct {
	db *Database
}

func NewSiteRepo(db *Database) *SiteRepo {
	return &SiteRepo{db: db}
}

// func (i Importer) LoadSite(db *Database, siteid string) (*Site, error) {
// 	info, err := i.client.GetEnergySiteInfo(siteid)
// 	if err != nil {
// 		return nil, fmt.Errorf("error getting energy site info: %w", err)
// 	}
// 	repo := NewEnergyRepo(db)
// 	site, err := repo.UpsertSite(siteid, info)
// 	if err != nil {
// 		return nil, fmt.Errorf("error upserting site info: %w", err)
// 	}
// 	logger.Debug("site upserted", slog.Any("site", site))

// 	return site, nil
// }
