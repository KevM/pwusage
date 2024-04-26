package fleetapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"reflect"

	fastshot "github.com/opus-domini/fast-shot"
	"github.com/opus-domini/fast-shot/constant/mime"
)

type FleetApiClient struct {
	baseUri     string
	bearerToken string
	logger      *slog.Logger
}

func NewFleetApiClient(token string, logger *slog.Logger) FleetApiClient {
	return FleetApiClient{
		baseUri:     fleetApiBaseUri,
		bearerToken: token,
		logger:      logger,
	}
}

func (c FleetApiClient) getClient() fastshot.ClientHttpMethods {
	return fastshot.NewClient(c.baseUri).
		Auth().BearerToken(c.bearerToken).
		Build()
}

func getOne[T any](c fastshot.ClientHttpMethods, url string, query string) (T, error) {
	var result T
	response, err := c.GET(url).Query().SetRawString(query).Header().AddAccept(mime.JSON).Send()
	if err != nil {
		return result, fmt.Errorf("error getting from url: %s %w", url, err)
	}

	if response.IsError() {
		bodyBytes, err := io.ReadAll(response.RawBody())
		if err != nil {
			return result, fmt.Errorf("non 200 ok response (%s) returned from web service; failed to ready body", response.Status())
		}
		bodyString := string(bodyBytes)
		return result, fmt.Errorf("non 200 ok response (%s) returned from web service:\n%s", response.Status(), bodyString)
	}

	body, err := io.ReadAll(response.RawBody())
	if err != nil {
		return result, fmt.Errorf("error reading response body: %w", err)
	}

	err = json.Unmarshal(body, &result)
	if err != nil {
		return result, fmt.Errorf("error unmarshaling %s from response body: %w", reflect.TypeOf((*T)(nil)).Elem(), err)
	}

	return result, nil
}
