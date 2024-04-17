package monitor

import (
	"fmt"

	"github.com/neomantra/ymdflag"
)

func VerifyDate(in string) (ymdflag.YMDFlag, error) {
	if in == "" {
		return ymdflag.YMDFlag{}, nil
	}
	startDate := ymdflag.YMDFlag{}
	err := startDate.Set(in)
	if err != nil {
		return startDate, fmt.Errorf("date must be a valid date. Error: %w", err)
	}

	return startDate, nil
}
