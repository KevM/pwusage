package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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

	callback := StartCallbackServer(ctx, config)
	url := config.Url()
	logger.Debug("opening url in browser", slog.String("url", url))
	OpenURLInBrowser(url)

	var out chan error
	func() {
		for {
			select {
			case <-ctx.Done():
				logger.Warn("authentication timed out")
				err := errors.New("authentication timed out")
				fmt.Println("authentication timed out")
				out <- err
				return
			case dotfile := <-callback.Result:
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
				cancel()
				out <- nil
				return
			default:
				time.Sleep(100 * time.Millisecond)
			}
		}
	}()

	return out
}

type UserAuthorizationResult struct {
	IdToken string `json:"id_token"`
}

type AuthConfig struct {
	Logger             *slog.Logger
	Action             string // login, revoke
	Scopes             []string
	Audience           string
	AuthDomain         string
	AuthClientId       string
	AuthClientSecret   string
	LocalCallbackPort  int
	LocalCallbackRoute string

	state string
	nonce string
}

func (c *AuthConfig) State() string {
	if c.state == "" {
		c.state = stringWithCharset(12, charset)
	}
	return c.state
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
		return c.RevokeUrl()
	default:
		return c.LoginUrl(c.State(), c.Nonce())
	}
}

func NewRevokeAuthConfig(logger *slog.Logger) (AuthConfig, error) {
	result, err := NewLoginAuthConfig(logger)
	if err != nil {
		return result, err
	}

	result.Action = "revoke"
	return result, nil
}

func NewLoginAuthConfig(logger *slog.Logger) (AuthConfig, error) {
	result := AuthConfig{
		Logger:     logger,
		Action:     "login",
		Scopes:     []string{"openid", "energy_device_data", "offline_access", "user_data", "energy_cmds"},
		AuthDomain: "https://auth.tesla.com/oauth2/v3/token",
		state:      stringWithCharset(12, charset),
		nonce:      stringWithCharset(12, charset),
	}

	clientid := os.Getenv("PUBLIC_TESLA_OAUTH_CLIENT_ID")
	if clientid == "" {
		return result, fmt.Errorf("PUBLIC_TESLA_OAUTH_CLIENT_ID env not set")
	}
	result.AuthClientId = clientid

	clientsecret := os.Getenv("TESLA_OAUTH_SECRET")
	if clientsecret == "" {
		return result, fmt.Errorf("TESLA_OAUTH_SECRET env not set")
	}
	result.AuthClientSecret = clientsecret

	audience := os.Getenv("PUBLIC_TESLA_OAUTH_AUDIENCE")
	if audience == "" {
		return result, fmt.Errorf("PUBLIC_TESLA_OAUTH_AUDIENCE env not set")
	}
	result.Audience = audience

	callbackRoute := os.Getenv("PUBLIC_AUTH_CALLBACK_ROUTE")
	if callbackRoute == "" {
		return result, fmt.Errorf("PUBLIC_AUTH_CALLBACK_ROUTE env not set")
	}
	result.LocalCallbackRoute = callbackRoute

	callbackPort := os.Getenv("PUBLIC_AUTH_CALLBACK_PORT")
	if callbackPort == "" {
		return result, fmt.Errorf("PUBLIC_AUTH_CALLBACK_PORT env not set")
	}
	port, err := strconv.Atoi(callbackPort)
	if err != nil {
		return result, fmt.Errorf("PUBLIC_AUTH_CALLBACK_PORT env not a number")
	}
	result.LocalCallbackPort = port

	return result, nil
}

func (c *AuthConfig) LoginUrl(state, nonce string) string {
	redirect_uri := fmt.Sprintf("http://localhost:%d%s", c.LocalCallbackPort, c.LocalCallbackRoute)
	scopes := strings.Join(c.Scopes, "%20")
	return fmt.Sprintf("https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&prompt=login&response_type=code&scope=%s&state=%s&redirect_uri=%s&client_id=%s&nonce=%s", scopes, state, redirect_uri, c.AuthClientId, nonce)
}

func (c *AuthConfig) RevokeUrl() string {
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

type AuthResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	State        string `json:"state"`
	TokenType    string `json:"token_type"`
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

func (c *AuthConfig) Exchange(code string, nonce string) DotFiles {
	data := url.Values{}
	data.Set("client_id", c.AuthClientId)
	data.Set("client_secret", c.AuthClientSecret)
	data.Set("audience", c.Audience)
	data.Set("redirect_uri", fmt.Sprintf("http://localhost:%d%s", c.LocalCallbackPort, c.LocalCallbackRoute))
	data.Set("grant_type", "authorization_code")
	data.Set("code", code)

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

	idtoken_nonce, err := ExtractNonceFromIdToken(auth.IDToken)
	if err != nil {
		return DotFiles{Error: fmt.Errorf("error extracting nonce from id_token: %w", err)}
	}
	if idtoken_nonce != nonce {
		return DotFiles{Error: fmt.Errorf("invalid nonce in id_token; expected %s got %s", nonce, idtoken_nonce)}
	}

	return DotFiles{
		AccessToken: auth.AccessToken,
		Refresh:     auth.RefreshToken,
		Error:       nil}
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
