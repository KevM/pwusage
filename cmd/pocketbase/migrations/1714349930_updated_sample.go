package migrations

import (
	"encoding/json"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/daos"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/models/schema"
)

func init() {
	m.Register(func(db dbx.Builder) error {
		dao := daos.New(db)

		collection, err := dao.FindCollectionByNameOrId("8256v6i6190ghb4")
		if err != nil {
			return err
		}

		// update
		edit_tariff := &schema.SchemaField{}
		if err := json.Unmarshal([]byte(`{
			"system": false,
			"id": "kzk1c5iu",
			"name": "tariff",
			"type": "select",
			"required": false,
			"presentable": false,
			"unique": false,
			"options": {
				"maxSelect": 1,
				"values": [
					"Off-Peak",
					"On-Peak"
				]
			}
		}`), edit_tariff); err != nil {
			return err
		}
		collection.Schema.AddField(edit_tariff)

		return dao.SaveCollection(collection)
	}, func(db dbx.Builder) error {
		dao := daos.New(db)

		collection, err := dao.FindCollectionByNameOrId("8256v6i6190ghb4")
		if err != nil {
			return err
		}

		// update
		edit_tariff := &schema.SchemaField{}
		if err := json.Unmarshal([]byte(`{
			"system": false,
			"id": "kzk1c5iu",
			"name": "tariff",
			"type": "select",
			"required": true,
			"presentable": false,
			"unique": false,
			"options": {
				"maxSelect": 1,
				"values": [
					"Off-Peak",
					"On-Peak"
				]
			}
		}`), edit_tariff); err != nil {
			return err
		}
		collection.Schema.AddField(edit_tariff)

		return dao.SaveCollection(collection)
	})
}
