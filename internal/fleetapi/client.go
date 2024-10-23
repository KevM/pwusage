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

type Client struct {
	baseUri     string
	bearerToken string
	logger      *slog.Logger
}

func NewFleetApiClient(token string, logger *slog.Logger) *Client {
	return &Client{
		baseUri:     fleetApiBaseUri,
		bearerToken: token,
		logger:      logger,
	}
}

func (c Client) getClient() fastshot.ClientHttpMethods {
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

	if response.Status().IsError() {
		bodyBytes, err := io.ReadAll(response.Body().Raw())
		if err != nil {
			return result, fmt.Errorf("non 200 ok response (%d) returned from web service; failed to read body", response.Status().Code())
		}
		bodyString := string(bodyBytes)
		return result, fmt.Errorf("non 200 ok response (%d) returned from web service:\n%s", response.Status().Code(), bodyString)
	}

	body, err := io.ReadAll(response.Body().Raw())
	if err != nil {
		return result, fmt.Errorf("error reading response body: %w", err)
	}

	err = json.Unmarshal(body, &result)
	if err != nil {
		return result, fmt.Errorf("error unmarshaling %s from response body: %w", reflect.TypeOf((*T)(nil)).Elem(), err)
	}

	return result, nil
}
