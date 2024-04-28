package monitor

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/foogod/go-powerwall"
)

type PwApi struct {
	Soe        float32
	Aggregates *map[string]powerwall.MeterAggregatesData
}

type PowerwallApi struct {
	client *powerwall.Client
	Logger *slog.Logger
}

func NewPowerwallApi(logger *slog.Logger) *PowerwallApi {
	host := os.Getenv("TESLA_GATEWAY_HOST")
	if host == "" {
		panic("TESLA_GATEWAY_HOST not set")
	}
	user := os.Getenv("TESLA_GATEWAY_USER")
	if user == "" {
		panic("TESLA_GATEWAY_USER not set")
	}

	password := os.Getenv("TESLA_GATEWAY_PASSWORD")
	if password == "" {
		panic("TESLA_GATEWAY_PASSWORD not set")
	}

	client := powerwall.NewClient(host, user, password)
	client.SetRetry(time.Second*1, time.Second*30) // retry every second, up to 30 seconds
	powerwall.SetLogFunc(func(v ...interface{}) {
		logger.Debug(fmt.Sprint(v...))
	})

	return &PowerwallApi{
		Logger: logger,
		client: client,
	}
}

func (p *PowerwallApi) GetPwApi() (PwApi, error) {
	var result PwApi

	aggregates, err := p.client.GetMetersAggregates()
	if err != nil {
		return result, err
	}

	soe, err := p.client.GetSOE()
	if err != nil {
		return result, err
	}

	return PwApi{
		Soe:        soe.Percentage,
		Aggregates: aggregates,
	}, nil
}
