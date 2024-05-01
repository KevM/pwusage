package auth

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	AccessTokenFileName       = ".auth"
	RefreshTokenFileName      = ".refresh"
	SelectedPortfolioFileName = ".portfolio"
)

func WritePortfolioDotfile(portfolioId string) error {
	configDir, err := getConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config directory: %w", err)
	}

	portfoliofn := filepath.Join(configDir, SelectedPortfolioFileName)
	err = os.WriteFile(portfoliofn, []byte(portfolioId), 0600)
	if err != nil {
		return fmt.Errorf("failed to write portfolio_id to file: %w", err)
	}

	return nil
}

type DotFiles struct {
	AccessToken string
	Refresh     string
	Error       error
}

// IsIdExpired checks the id_token to see if it has expired
func (t DotFiles) IsIdExpired() bool {
	token, _, err := new(jwt.Parser).ParseUnverified(t.AccessToken, jwt.MapClaims{})
	if err != nil {
		// Could not parse the token? It can't be valid.
		return true
	}

	if claims, ok := token.Claims.(jwt.MapClaims); ok {
		exp, err := claims.GetExpirationTime()
		if err != nil {
			return true
		}

		return exp.Time.Before(time.Now())
	}

	// did not find expiration claim? This token can't be valid.
	return true
}

func (t DotFiles) WriteToDotFiles() error {
	configDir, err := getConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config directory: %w", err)
	}

	accessfn := filepath.Join(configDir, AccessTokenFileName)
	err = os.WriteFile(accessfn, []byte(t.AccessToken), 0600)
	if err != nil {
		return fmt.Errorf("failed to write access_token to file: %w", err)
	}

	refreshfn := filepath.Join(configDir, RefreshTokenFileName)
	err = os.WriteFile(refreshfn, []byte(t.Refresh), 0600)
	if err != nil {
		return fmt.Errorf("failed to write id_token to file: %w", err)
	}

	return nil
}

func NewFromDotFiles() DotFiles {
	result := DotFiles{}

	configDir, err := getConfigDir()
	if err != nil {
		result.Error = fmt.Errorf("failed to get config directory: %w", err)
		return result
	}

	fn := filepath.Join(configDir, AccessTokenFileName)
	bytes, err := os.ReadFile(fn)
	if err != nil {
		result.Error = fmt.Errorf("failed to read access_token file: %w", err)
		return result
	}
	result.AccessToken = string(bytes)

	fn = filepath.Join(configDir, RefreshTokenFileName)
	bytes, err = os.ReadFile(fn)
	if err != nil {
		result.Error = fmt.Errorf("failed to read refersh_token file: %w", err)
		return result
	}
	result.Refresh = string(bytes)

	return result
}

func getConfigDir() (string, error) {
	homeDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("failed to get user home directory: %w", err)
	}

	appDir := filepath.Join(homeDir, ".pw-usage")
	os.MkdirAll(appDir, 0700)

	return appDir, nil
}
