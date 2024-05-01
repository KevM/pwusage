package auth

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"time"
)

type Callback struct {
	Config AuthConfig
	State  string
	Nonce  string
	Result chan DotFiles
}

// start web server to handle callback from auth provider. Resulting nimble id_token is put into the channel when it is received
func StartCallbackServer(ctx context.Context, config AuthConfig, logger *slog.Logger) Callback {
	logger.Debug("starting callback server", slog.Any("config", config))
	state := stringWithCharset(12, charset)
	nonce := stringWithCharset(12, charset)
	tokenChannel := make(chan DotFiles)
	result := Callback{
		Config: config,
		State:  state,
		Nonce:  nonce,
		Result: tokenChannel,
	}

	responseReceived := false

	handler := func(w http.ResponseWriter, r *http.Request) {
		// latch handler to only work once.
		if responseReceived {
			fmt.Println("already handling the request...")
			return
		}
		responseReceived = true

		err := validateState(r, state)
		if err != nil {
			http.Error(w, "There was a problem logging in. Please try again.", http.StatusUnauthorized)
			tokenChannel <- DotFiles{Error: err}
			return
		}

		code := r.URL.Query().Get("code")
		tokens := config.Exchange(code, nonce)
		tokenChannel <- tokens
		if tokens.Error != nil {
			logger.Error("Could not exchange code for nimble auth token. Is this user authorized?", slog.Any("error", tokens.Error))
			http.Error(w, "There was a problem logging in. Please try again.", http.StatusUnauthorized)
			return
		}

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
			case <-tokenChannel:
				logger.Debug("auth callback server received a token. Shutting down callback server")
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

	return result
}

func validateState(r *http.Request, state string) error {
	s := r.URL.Query().Get("state")
	if s != state {
		return fmt.Errorf("auth callback state does not match: %s != %s", s, state)
	}
	return nil
}

const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func stringWithCharset(length int, charset string) string {
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}
