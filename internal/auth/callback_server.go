package auth

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
)

func StartCallbackServer(ctx context.Context, config AuthConfig) chan DotFiles {
	logger := config.Logger
	logger.Debug("starting callback server", slog.Any("config", config))
	tokenChannel := make(chan DotFiles)

	responseReceived := false

	handler := func(w http.ResponseWriter, r *http.Request) {
		// latch handler to only work once.
		if responseReceived {
			fmt.Println("already handling the request...")
			return
		}
		responseReceived = true

		if config.Action == "revoke" {
			err := RemoveDotFiles()
			if err != nil {
				logger.Error("Error removing dotfiles", slog.Any("error", err))
				http.Error(w, "There was a problem revoking or changing API access. Please try again.", http.StatusUnauthorized)
				return
			}
			io.WriteString(w, "You can close this browser window.")
		}

		// extract tokens from headers
		tokens := config.extractDotfileFromRequest(r)
		if tokens.Error != nil {
			logger.Error("Error extracting tokens from request", slog.Any("error", tokens.Error))
			http.Error(w, "There was a problem logging in. Please try again.", http.StatusUnauthorized)
			return
		}
		tokenChannel <- tokens
		io.WriteString(w, "You can close this browser window.")
	}

	server := &http.Server{
		Addr: fmt.Sprintf(":%d", config.LocalCallbackPort),
	}
	logger.Debug("registering auth callback handler for route", slog.String("route", config.LocalCallbackRoute))
	http.HandleFunc(config.LocalCallbackRoute, handler)

	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			logger.Error("Error starting http server on port", slog.Any("error", err), slog.Int("port", config.LocalCallbackPort))
			close(tokenChannel)
		}

		logger.Debug("auth callback server started", slog.String("route", config.LocalCallbackRoute), slog.Int("port", config.LocalCallbackPort))

		for {
			select {
			case token := <-tokenChannel:
				logger.Debug("auth callback server received a token. Shutting down callback server", slog.Any("token", token))
				// shutdown the server after we get a result
				timeoutCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
				if err := server.Shutdown(timeoutCtx); err != nil {
					logger.Error("Auth callback server shutdown failed", slog.Any("error", err))
					os.Exit(-1)
				}
				close(tokenChannel)
				cancel()
			default:
				time.Sleep(100 * time.Millisecond)
			}
		}
	}()

	return tokenChannel
}

func (config AuthConfig) extractDotfileFromRequest(r *http.Request) DotFiles {
	q := r.URL.Query()
	authToken := q.Get("auth")
	refreshToken := q.Get("refresh")
	idToken := q.Get("id")

	if idToken == "" || authToken == "" || refreshToken == "" {
		config.Logger.Error("missing tokens in headers", slog.String("id_token", idToken), slog.String("auth_token", authToken), slog.String("refresh_token", refreshToken))
		return DotFiles{Error: fmt.Errorf("missing tokens in headers")}
	}

	//validate the id token
	idtoken_nonce, err := ExtractNonceFromIdToken(idToken)
	if err != nil {
		return DotFiles{Error: fmt.Errorf("error extracting nonce from id_token: %w", err)}
	}

	if idtoken_nonce != config.Nonce() {
		return DotFiles{Error: fmt.Errorf("invalid nonce in id_token; expected %s got %s", config.Nonce(), idtoken_nonce)}
	}

	return DotFiles{
		AccessToken: authToken,
		Refresh:     refreshToken,
	}
}
