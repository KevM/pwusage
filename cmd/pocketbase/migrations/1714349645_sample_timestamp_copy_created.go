package migrations

import (
	"github.com/pocketbase/dbx"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(db dbx.Builder) error {
		// add up queries...
		_, err := db.NewQuery("UPDATE sample SET timestamp = created WHERE timestamp < 0").Execute()
		return err
	}, func(db dbx.Builder) error {
		// add down queries...

		return nil
	})
}
