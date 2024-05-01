module github.com/kevm/pw-usage

go 1.22.2

replace github.com/kevm/pw-usage/cmd/pocketbase/migrations => ./migrations

replace github.com/kevm/pw-usage/internal/monitoring => ./internal/monitoring

require (
	github.com/google/uuid v1.6.0
	github.com/joho/godotenv v1.5.1
	github.com/neomantra/ymdflag v0.2.0
	github.com/opus-domini/fast-shot v0.10.0
	github.com/spf13/cobra v1.8.0
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.5 // indirect
)
