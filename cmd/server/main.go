package main

import (
	"log"
	"net/http"

	"github.com/kevm/pw-usage/internal/config"
)

// recoveryMiddleware recovers from panics in handlers and returns an HTTP 500.
func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// NewServer constructs the HTTP server and its root handler.
func NewServer(cfg *config.Config) (*http.Server, http.Handler) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	handler := recoveryMiddleware(mux)
	srv := &http.Server{
		Addr:    ":8080",
		Handler: handler,
	}
	if cfg != nil && cfg.Logger != nil {
		cfg.Logger.Info("server initialized")
	}
	return srv, handler
}

func main() {
	cfg, err := config.NewConfig("")
	if err != nil {
		log.Fatalf("failed to create config: %v", err)
	}
	srv, _ := NewServer(&cfg)
	log.Printf("listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
