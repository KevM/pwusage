package fleetdb

import (
	"testing"
	"time"
)

func TestTariffSchedule_GetTariffPeriod(t *testing.T) {
	siteid := "2252268092126997"
	var err error
	db, client, logger, err := Setup("./pw-testing.db")
	if err != nil {
		logger.Error("error setting up db", "error", err)
		t.Fail()
		return
	}
	defer db.DeleteDb()

	repo := NewEnergyRepo(db, logger)
	site, err := repo.LoadSite(siteid, client)
	if err != nil {
		logger.Error("error loading site", "error", err)
		t.Fail()
		return
	}

	schedule := NewSchedule(site.Tariffs)

	// Test for weekday before 8am
	weekdayEarly := time.Date(2024, 4, 2, 7, 0, 0, 0, site.Location)
	tp := schedule.GetTariffPeriod(weekdayEarly)
	if tp == nil {
		t.Errorf("Expected tariff period but got nil")
		return
	}

	if tp.Tariff.Name != "OFF_PEAK" {
		t.Errorf("Expected OFF_PEAK but got %s", tp.Tariff.Name)
	}

	// weird that tesla has the seasons name summer and winter when in the app they are Season1 and Season2
	// Also you'll notice that Tesla's app has summer and winter backwards.
	if tp.Season.Name != "Summer" {
		t.Errorf("Expected Summer but got %s", tp.Season.Name)
	}

	expectedEnd := time.Date(2024, 4, 2, 8, 0, 0, 0, site.Location)
	if !tp.End.Equal(expectedEnd) {
		t.Errorf("Expected %v but got %v", expectedEnd, tp)
	}

	expectedStart := time.Date(2024, 4, 2, 0, 0, 0, 0, site.Location)
	if !tp.Start.Equal(expectedStart) {
		t.Errorf("Expected %v but got %v", expectedStart, tp)
	}

	// Test for weekend
	weekendNoonish := time.Date(2024, 4, 6, 14, 0, 0, 0, site.Location)
	tp = schedule.GetTariffPeriod(weekendNoonish)
	if tp == nil {
		t.Errorf("Expected tariff period but got nil")
		return
	}

	if tp.Tariff.Name != "OFF_PEAK" {
		t.Errorf("Expected OFF_PEAK but got %s", tp.Tariff.Name)
	}

	if tp.Season.Name != "Summer" {
		t.Errorf("Expected Summer but got %s", tp.Season.Name)
	}

	expectedEnd = time.Date(2024, 4, 7, 0, 0, 0, 0, site.Location)
	if !tp.End.Equal(expectedEnd) {
		t.Errorf("Expected %v but got %v", expectedEnd, tp)
	}

	expectedStart = time.Date(2024, 4, 6, 0, 0, 0, 0, site.Location)
	if !tp.Start.Equal(expectedStart) {
		t.Errorf("Expected %v but got %v", expectedStart, tp)
	}

	weekdayAfternoon := time.Date(2024, 4, 4, 16, 0, 0, 0, site.Location)
	tp = schedule.GetTariffPeriod(weekdayAfternoon)
	if tp == nil {
		t.Errorf("Expected tariff period but got nil")
		return
	}

	if tp.Tariff.Name != "ON_PEAK" {
		t.Errorf("Expected ON_PEAK but got %s", tp.Tariff.Name)
	}

	if tp.Season.Name != "Summer" {
		t.Errorf("Expected Summer but got %s", tp.Season.Name)
	}

	expectedEnd = time.Date(2024, 4, 4, 20, 0, 0, 0, site.Location)
	if !tp.End.Equal(expectedEnd) {
		t.Errorf("Expected %v but got %v", expectedEnd, tp)
	}

	expectedStart = time.Date(2024, 4, 4, 8, 0, 0, 0, site.Location)
	if !tp.Start.Equal(expectedStart) {
		t.Errorf("Expected %v but got %v", expectedStart, tp)
	}

	boundary := time.Date(2024, 4, 4, 8, 0, 0, 1, site.Location)
	tp = schedule.GetTariffPeriod(boundary)
	if tp == nil {
		t.Errorf("Expected tariff period but got nil")
		return
	}

	if tp.Tariff.Name != "ON_PEAK" {
		t.Errorf("Expected ON_PEAK but got %s", tp.Tariff.Name)
	}

	if tp.Season.Name != "Summer" {
		t.Errorf("Expected Summer but got %s", tp.Season.Name)
	}

	expectedEnd = time.Date(2024, 4, 4, 20, 0, 0, 0, site.Location)
	if !tp.End.Equal(expectedEnd) {
		t.Errorf("Expected %v but got %v", expectedEnd, tp)
	}

	expectedStart = time.Date(2024, 4, 4, 8, 0, 0, 0, site.Location)
	if !tp.Start.Equal(expectedStart) {
		t.Errorf("Expected %v but got %v", expectedStart, tp)
	}
}
