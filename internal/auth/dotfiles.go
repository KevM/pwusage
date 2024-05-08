package auth

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	AuthTokenFileName    = ".auth"
	RefreshTokenFileName = ".refresh"
	SiteIDFileName       = ".siteid"
	BillStartDayFileName = ".billstart"
)

type DotFiles struct {
	AccessToken string
	Refresh     string
	Error       error

	Siteid       string
	BillStartDay int
}

func RemoveDotFiles() error {
	configDir, err := getConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config directory: %w", err)
	}

	billfn := filepath.Join(configDir, BillStartDayFileName)
	err = os.Remove(billfn)
	if err != nil {
		return fmt.Errorf("failed to remove bill_start file: %w", err)
	}

	sitefn := filepath.Join(configDir, SiteIDFileName)
	err = os.Remove(sitefn)
	if err != nil {
		return fmt.Errorf("failed to remove site_id file: %w", err)
	}

	accessfn := filepath.Join(configDir, AuthTokenFileName)
	err = os.Remove(accessfn)
	if err != nil {
		return fmt.Errorf("failed to remove auth_token file: %w", err)
	}

	refreshfn := filepath.Join(configDir, AuthTokenFileName)
	err = os.Remove(refreshfn)
	if err != nil {
		return fmt.Errorf("failed to remove refresh_token file: %w", err)
	}
	return nil
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

	billfn := filepath.Join(configDir, BillStartDayFileName)
	err = os.WriteFile(billfn, []byte(fmt.Sprintf("%d", t.BillStartDay)), 0600)
	if err != nil {
		return fmt.Errorf("failed to write bill_start file: %w", err)
	}

	sitefn := filepath.Join(configDir, SiteIDFileName)
	err = os.WriteFile(sitefn, []byte(t.Siteid), 0600)
	if err != nil {
		return fmt.Errorf("failed to write site_id file: %w", err)
	}

	accessfn := filepath.Join(configDir, AuthTokenFileName)
	err = os.WriteFile(accessfn, []byte(t.AccessToken), 0600)
	if err != nil {
		return fmt.Errorf("failed to write auth_token to file: %w", err)
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

	fn := filepath.Join(configDir, BillStartDayFileName)
	bytes, err := os.ReadFile(fn)
	if err != nil {
		result.Error = fmt.Errorf("failed to read bill_start file: %w", err)
		return result
	}
	bs, err := strconv.Atoi(string(bytes)) // string to int default to 11
	if err != nil {
		bs = 11
	}
	result.BillStartDay = bs

	fn = filepath.Join(configDir, SiteIDFileName)
	bytes, err = os.ReadFile(fn)
	if err != nil {
		result.Error = fmt.Errorf("failed to read site_id file: %w", err)
		return result
	}
	result.Siteid = string(bytes)

	fn = filepath.Join(configDir, AuthTokenFileName)
	bytes, err = os.ReadFile(fn)
	if err != nil {
		result.Error = fmt.Errorf("failed to read auth_token file: %w", err)
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
