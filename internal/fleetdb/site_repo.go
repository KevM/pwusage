package fleetdb

type SiteRepo struct {
	db *Database
}

func NewSiteRepo(db *Database) *SiteRepo {
	return &SiteRepo{db: db}
}
