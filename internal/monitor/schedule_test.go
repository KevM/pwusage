package monitor

import (
	"testing"
	"time"
)

func TestTariffSchedule_GetTariffPeriod(t *testing.T) {
	ts := &TimeOfUse{}

	// Test for weekday before 8am
	now := time.Date(2024, 4, 2, 7, 0, 0, 0, time.UTC) // Monday
	tp := ts.GetTariffPeriod(now)

	expectedEnd := time.Date(2024, 4, 2, 8, 0, 0, 0, time.UTC)
	if !tp.End.Equal(expectedEnd) {
		t.Errorf("Expected %v but got %v", expectedEnd, tp)
	}

	expectedStart := time.Date(2024, 4, 2, 0, 0, 0, 0, time.UTC)
	if !tp.Start.Equal(expectedStart) {
		t.Errorf("Expected %v but got %v", expectedStart, tp)
	}
}

func TestTariffSchedule_Next(t *testing.T) {
	ts := &TimeOfUse{}

	// Test for weekday before 8am
	now := time.Date(2024, 4, 2, 7, 0, 0, 0, time.UTC) // Monday
	next := ts.Next(now)
	expected := time.Date(2024, 4, 2, 8, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, next)
	}

	// Test for weekday after 8am and before 8pm
	now = time.Date(2024, 4, 2, 9, 0, 0, 0, time.UTC) // Monday
	next = ts.Next(now)
	expected = time.Date(2024, 4, 2, 20, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, next)
	}

	// Test for weekday after 8pm
	now = time.Date(2024, 4, 2, 21, 0, 0, 0, time.UTC) // Monday
	next = ts.Next(now)
	expected = time.Date(2024, 4, 3, 0, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, next)
	}

	// Test for weekend on saturday
	now = time.Date(2024, 4, 6, 7, 0, 0, 0, time.UTC) // Saturday
	next = ts.Next(now)
	expected = time.Date(2024, 4, 7, 0, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, next)
	}

	// Test for weekend on sunday
	now = time.Date(2024, 4, 7, 13, 0, 0, 0, time.UTC) // Saturday
	next = ts.Next(now)
	expected = time.Date(2024, 4, 8, 0, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, next)
	}
}

func TestTariffSchedule_Prev(t *testing.T) {
	ts := &TimeOfUse{}

	// Test for weekday before 8am
	now := time.Date(2024, 4, 2, 7, 0, 0, 0, time.UTC) // Monday
	prev := ts.Prev(now)
	expected := time.Date(2024, 4, 2, 0, 0, 0, 0, time.UTC)
	if !prev.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, prev)
	}

	// Test for weekday after 8am and before 8pm
	now = time.Date(2024, 4, 2, 9, 0, 0, 0, time.UTC) // Monday
	prev = ts.Prev(now)
	expected = time.Date(2024, 4, 2, 8, 0, 0, 0, time.UTC)
	if !prev.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, prev)
	}

	// Test for weekday after 8pm
	now = time.Date(2024, 4, 2, 21, 0, 0, 0, time.UTC) // Monday
	prev = ts.Prev(now)
	expected = time.Date(2024, 4, 2, 20, 0, 0, 0, time.UTC)
	if !prev.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, prev)
	}

	// Test for weekend on saturday
	now = time.Date(2024, 4, 6, 7, 0, 0, 0, time.UTC) // Saturday
	prev = ts.Prev(now)
	expected = time.Date(2024, 4, 6, 0, 0, 0, 0, time.UTC)
	if !prev.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, prev)
	}

	// Test for weekend on sunday
	now = time.Date(2024, 4, 7, 13, 0, 0, 0, time.UTC) // Saturday
	prev = ts.Prev(now)
	expected = time.Date(2024, 4, 7, 0, 0, 0, 0, time.UTC)
	if !prev.Equal(expected) {
		t.Errorf("Expected %v but got %v", expected, prev)
	}
}
