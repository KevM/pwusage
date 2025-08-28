package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kevm/pw-usage/internal/config"
)

func TestHealthz(t *testing.T) {
	cfg := &config.Config{}
	_, handler := NewServer(cfg)
	ts := httptest.NewServer(handler)
	defer ts.Close()

	resp, err := ts.Client().Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("failed to get /healthz: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 got %d", resp.StatusCode)
	}
	if string(body) != "ok" {
		t.Fatalf("expected body 'ok' got %q", string(body))
	}
}

func TestRecoveryMiddleware(t *testing.T) {
	handler := recoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	ts := httptest.NewServer(handler)
	defer ts.Close()

	resp, err := ts.Client().Get(ts.URL)
	if err != nil {
		t.Fatalf("failed to get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected status 500 got %d", resp.StatusCode)
	}
}
