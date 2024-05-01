package fleetapi

import (
	"fmt"
	"io"
	"log/slog"

	fastshot "github.com/opus-domini/fast-shot"
	"github.com/opus-domini/fast-shot/constant/mime"
)

func postSetBatteryReserveUrl(siteId string) string {
	url := fmt.Sprintf("/api/1/energy_sites/%s/backup", siteId)
	return url
}

func (c *Client) SetBatteryReserve(siteid string, reserve int) error {
	uri := postSetBatteryReserveUrl(siteid)
	payload := map[string]interface{}{
		"backup_reserve_percent": reserve,
	}
	err := postBody(c.getClient(), uri, payload)
	if err != nil {
		c.logger.Error("Error setting battery reserve", slog.Any("error", err))
		return err
	}

	return nil
}

func postBody(c fastshot.ClientHttpMethods, url string, body interface{}) error {
	response, err := c.POST(url).
		Header().AddAccept(mime.JSON).
		Body().AsJSON(body).
		Send()

	if err != nil {
		return fmt.Errorf("error posting to url: %s %w", url, err)
	}

	if response.IsError() {
		bodyBytes, err := io.ReadAll(response.RawBody())
		if err != nil {
			return fmt.Errorf("non 200 ok response (%s) returned from web service; failed to read body", response.Status())
		}
		bodyString := string(bodyBytes)
		return fmt.Errorf("non 200 ok response (%s) returned from web service:\n%s", response.Status(), bodyString)
	}

	return nil
}
