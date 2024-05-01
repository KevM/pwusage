package config

import (
	"testing"
	"time"

	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/stretchr/testify/require"
)

func TestTariffSchedule_GetTariffPeriod(t *testing.T) {
	siteid := "2252268092126997"
	config, err := NewConfig()
	require.NoError(t, err)
	defer config.Database.DeleteDb()

	repo := fleetdb.NewEnergyRepo(config.Database, config.Logger)
	site, err := repo.LoadSite(siteid, config.Client)
	require.NoError(t, err)

	schedule := fleetdb.NewSchedule(site.Tariffs)

	// Test for weekday before 8am
	weekdayEarly := time.Date(2024, 4, 2, 7, 0, 0, 0, site.Location)
	tp := schedule.GetTariffPeriod(weekdayEarly)
	require.NotNil(t, tp)
	require.Equal(t, "OFF_PEAK", tp.Tariff.Name)

	// weird that tesla has the seasons name summer and winter when in the app they are Season1 and Season2
	// Also you'll notice that Tesla's app has summer and winter backwards.
	require.Equal(t, "Summer", tp.Season.Name)

	expectedEnd := time.Date(2024, 4, 2, 8, 0, 0, 0, site.Location)
	require.Equal(t, expectedEnd, tp.End)

	expectedStart := time.Date(2024, 4, 2, 0, 0, 0, 0, site.Location)
	require.Equal(t, expectedStart, tp.Start)

	weekendNoonish := time.Date(2024, 4, 6, 14, 0, 0, 0, site.Location)
	tp = schedule.GetTariffPeriod(weekendNoonish)
	require.NotNil(t, tp)
	require.Equal(t, "OFF_PEAK", tp.Tariff.Name)
	require.Equal(t, "Summer", tp.Season.Name)
	expectedEnd = time.Date(2024, 4, 7, 0, 0, 0, 0, site.Location)
	require.Equal(t, expectedEnd, tp.End)
	expectedStart = time.Date(2024, 4, 6, 0, 0, 0, 0, site.Location)
	require.Equal(t, expectedStart, tp.Start)

	weekdayAfternoon := time.Date(2024, 4, 4, 16, 0, 0, 0, site.Location)
	tp = schedule.GetTariffPeriod(weekdayAfternoon)
	require.NotNil(t, tp)
	require.Equal(t, "ON_PEAK", tp.Tariff.Name)
	require.Equal(t, "Summer", tp.Season.Name)
	expectedEnd = time.Date(2024, 4, 4, 20, 0, 0, 0, site.Location)
	require.Equal(t, expectedEnd, tp.End)
	expectedStart = time.Date(2024, 4, 4, 8, 0, 0, 0, site.Location)
	require.Equal(t, expectedStart, tp.Start)

	boundary := time.Date(2024, 4, 4, 8, 0, 0, 1, site.Location)
	tp = schedule.GetTariffPeriod(boundary)
	require.NotNil(t, tp)
	require.Equal(t, "ON_PEAK", tp.Tariff.Name)
	require.Equal(t, "Summer", tp.Season.Name)
	expectedEnd = time.Date(2024, 4, 4, 20, 0, 0, 0, site.Location)
	require.Equal(t, expectedEnd, tp.End)
	expectedStart = time.Date(2024, 4, 4, 8, 0, 0, 0, site.Location)
	require.Equal(t, expectedStart, tp.Start)
}
