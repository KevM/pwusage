package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func NewOAuthAction(config AuthConfig) chan error {
	logger := config.Logger
	timeout := 120 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	ch_callback := StartCallbackServer(ctx, config)
	url := config.Url()
	logger.Debug("opening url in browser", slog.String("url", url))
	OpenURLInBrowser(url)

	out := make(chan error, 10)
	func() {
		for {
			select {
			case <-ctx.Done():
				logger.Warn("authentication timed out")
				err := errors.New("authentication timed out")
				fmt.Println("authentication timed out")
				out <- err
				return
			case dotfile := <-ch_callback:
				if dotfile.Error != nil {
					logger.Error("error getting auth tokens. .", slog.Any("error", dotfile.Error))
					fmt.Println("authentication failed.")
					out <- dotfile.Error
					return
				}

				// maybe use lipgloss to make output look pretty on the cli?
				err := dotfile.WriteToDotFiles()
				if err != nil {
					logger.Error("error writing auth tokens to dotfiles", slog.Any("error", err))
					fmt.Println("authentication failed to write result to disk: %w", err)
					out <- err
					return
				}
				logger.Info("authentication successful; auth tokens written to dotfiles")
				fmt.Println("authentication successful")
				out <- nil
				cancel()
				return
			default:
				time.Sleep(100 * time.Millisecond)
			}
		}
	}()

	return out
}

type AuthConfig struct {
	Logger             *slog.Logger
	Action             string // login, revoke
	AuthClientId       string
	LocalCallbackPort  int
	LocalCallbackRoute string
	WebAppBase         string

	nonce string
}

func NewLoginAuthConfig(logger *slog.Logger) (AuthConfig, error) {
	result := AuthConfig{
		Logger: logger,
		Action: "login",
		nonce:  stringWithCharset(12, charset),
	}
	cwd, _ := os.Getwd()
	logger.Debug("current working directory", slog.String("cwd", cwd))

	baseurl := os.Getenv("PUBLIC_WEBAPP_BASE_URL")
	if baseurl == "" {
		return result, fmt.Errorf("PUBLIC_WEBAPP_BASE_URL env not set")
	}
	result.WebAppBase = baseurl

	clientid := os.Getenv("PUBLIC_TESLA_OAUTH_CLIENT_ID")
	if clientid == "" {
		return result, fmt.Errorf("PUBLIC_TESLA_OAUTH_CLIENT_ID env not set")
	}
	result.AuthClientId = clientid

	callbackRoute := os.Getenv("PUBLIC_AUTH_CALLBACK_ROUTE")
	if callbackRoute == "" {
		logger.Warn("PUBLIC_AUTH_CALLBACK_ROUTE env not set - using default '/callback'")
		callbackRoute = "/callback"
	}
	result.LocalCallbackRoute = callbackRoute

	callbackPort := os.Getenv("PUBLIC_AUTH_CALLBACK_PORT")
	if callbackPort == "" {
		logger.Warn("PUBLIC_AUTH_CALLBACK_PORT env not set - using default '6789'")
		callbackPort = "6789"
	}
	port, err := strconv.Atoi(callbackPort)
	if err != nil {
		return result, fmt.Errorf("PUBLIC_AUTH_CALLBACK_PORT env not a number")
	}
	result.LocalCallbackPort = port

	return result, nil
}

func (c *AuthConfig) Nonce() string {
	if c.nonce == "" {
		c.nonce = stringWithCharset(12, charset)
	}
	return c.nonce
}

func (c *AuthConfig) Url() string {
	switch c.Action {
	case "revoke":
		return c.revokeUrl()
	default:
		return c.loginUrl()
	}
}

func (c *AuthConfig) loginUrl() string {
	callbackUri := fmt.Sprintf("http://localhost:%d%s", c.LocalCallbackPort, c.LocalCallbackRoute)
	loginUrl := fmt.Sprintf("%s/login", c.WebAppBase)

	return fmt.Sprintf("%s?nonce=%s&callback=%s", loginUrl, c.Nonce(), callbackUri)
}

func (c *AuthConfig) revokeUrl() string {
	redirect_uri := fmt.Sprintf("http://localhost:%d%s", c.LocalCallbackPort, c.LocalCallbackRoute)

	return fmt.Sprintf("https://auth.tesla.com/user/revoke/consent?revoke_client_id=%s&back_url=%s", c.AuthClientId, redirect_uri)
}

// LoadDotFiles loads tokens from the user's dot files and checks if it is about to expire.
// If so it will refresh the auth tokens and write back to the dot files
// Any errors are returned in the DotFiles struct Errors field
func (c AuthConfig) LoadDotFiles(logger *slog.Logger) DotFiles {
	dotfiles := NewFromDotFiles()
	if dotfiles.Error != nil {
		return dotfiles
	}

	logger.Debug("loaded auth tokens from dotfiles")

	if dotfiles.IsIdExpired() {
		dotfiles = c.Refresh(dotfiles.Refresh)
		if dotfiles.Error != nil {
			return dotfiles
		}

		logger.Debug("refreshed auth tokens")

		err := dotfiles.WriteToDotFiles()
		if err != nil {
			return DotFiles{Error: err}
		}

		logger.Debug("refreshed auth tokens writted to dotfiles")
	}

	return dotfiles
}

func (c *AuthConfig) Refresh(refreshToken string) DotFiles {
	data := url.Values{}
	data.Set("client_id", c.AuthClientId)
	data.Set("grant_type", "refresh_token")
	data.Set("refresh_token", refreshToken)

	resp, err := http.Post(
		"https://auth.tesla.com/oauth2/v3/token",
		"application/x-www-form-urlencoded",
		strings.NewReader(data.Encode()),
	)
	if err != nil {
		return DotFiles{Error: fmt.Errorf("error making request: %w", err)}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return DotFiles{Error: fmt.Errorf("error reading response body: %w", err)}
	}

	if resp.StatusCode != http.StatusOK {
		return DotFiles{Error: fmt.Errorf("error: %d; body: %s", resp.StatusCode, string(body))}
	}

	var auth AuthResponse
	err = json.Unmarshal(body, &auth)
	if err != nil {
		return DotFiles{Error: fmt.Errorf("error unmarshalling response body: %w", err)}
	}

	return DotFiles{
		AccessToken: auth.AccessToken,
		Refresh:     auth.RefreshToken,
		Error:       nil}
}

type AuthResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	State        string `json:"state"`
	TokenType    string `json:"token_type"`
}

func ExtractNonceFromIdToken(idToken string) (string, error) {
	type nonceClaims struct {
		jwt.Claims
		Nonce string `json:"nonce"`
		// ... (other custom claims) ...
	}
	var result string

	token, _, err := new(jwt.Parser).ParseUnverified(idToken, &nonceClaims{})
	if err != nil {
		return result, fmt.Errorf("error parsing token: %w", err)
	}

	claims, ok := token.Claims.(*nonceClaims)
	if !ok {
		return result, errors.New("error casting token claims to NonceClaims")
	}

	result = claims.Nonce
	return result, nil
}

// open opens the specified URL in the default browser of the user.
// https://stackoverflow.com/questions/39320371/how-start-web-server-to-open-page-in-browser-in-golang
func OpenURLInBrowser(url string) error {
	var cmd string
	var args []string

	switch runtime.GOOS {
	case "windows":
		cmd = "cmd"
		args = []string{"/c", "start"}
	case "darwin":
		cmd = "open"
	default: // "linux", "freebsd", "openbsd", "netbsd"
		cmd = "xdg-open"
	}
	args = append(args, url)
	return exec.Command(cmd, args...).Start()
}

const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func stringWithCharset(length int, charset string) string {
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}
