package tui

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/kevm/pw-usage/internal/tui/settings"
)

type ShowSettings struct{}
type UpdateUsages struct{}

type Model struct {
	Config *config.Config

	settingsModel *settings.Model
	usages        []fleetdb.UsageData
}

func NewModel(config *config.Config) *Model {
	return &Model{
		Config: config,
	}
}

func (m Model) Init() tea.Cmd {
	if m.Config.Site == nil {
		return cmdize(ShowSettings{})
	} else {
		return cmdize(UpdateUsages{})
	}
	return nil
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case ShowSettings:
		m.settingsModel = settings.NewModel(m.Config)
		return m, m.settingsModel.Init()
	case UpdateUsages:
		if err := m.loadUsages(); err != nil {
			m.Config.Logger.Error("Error loading usages", slog.Any("error", err))
		}
		tickUsages := tea.Every(5*time.Minute, func(t time.Time) tea.Msg {
			return UpdateUsages{}
		})
		return m, tickUsages
	case settings.SettingsUpdated:
		// update config
		m.Config.BillStartDay = msg.BillingStartDay
		err := m.loadSite(msg.SiteId)
		if err != nil {
			m.Config.Logger.Error("Error loading site", slog.Any("error", err))
			return m, tea.Quit
		}

		// save config
		err = m.Config.SaveToDotFiles()
		if err != nil {
			m.Config.Logger.Error("Error saving settings to dotfiles", slog.Any("error", err))
		}

		m.settingsModel = nil
		return m, cmdize(UpdateUsages{})
	case tea.KeyMsg:
		switch msg.String() {
		case "q":
			return m, tea.Quit
		}
	}

	if m.settingsModel != nil {
		sm, cmd := m.settingsModel.Update(msg)
		if sm != nil {
			smp := sm.(settings.Model)
			m.settingsModel = &smp
		}
		return m, cmd
	}

	return m, nil
}

func (m Model) View() string {
	if m.settingsModel != nil {
		return m.settingsModel.View()
	}

	if m.Config.Site == nil {
		return "No site configured"
	}

	header := lipgloss.NewStyle().Render(m.Config.Site.Name)

	report, err := m.usageReport()
	if err != nil {
		return fmt.Sprintf("Error generating usage report: %s", err)
	}

	return lipgloss.JoinVertical(lipgloss.Left, header, report)
}

func cmdize[T any](t T) tea.Cmd {
	return func() tea.Msg {
		return t
	}
}

func (m *Model) loadSite(siteid string) error {
	repo := fleetdb.NewEnergyRepo(m.Config.Database, m.Config.Logger)
	site, err := repo.LoadSite(siteid, m.Config.Client)
	if err != nil {
		return err
	}
	m.Config.Site = site
	return nil
}

func (m *Model) loadUsages() error {
	start, end := m.getDateRange()
	usage := fleetdb.NewUsage(m.Config.Site, m.Config.Database, m.Config.Client, m.Config.Logger)
	usages, err := usage.GetEnergyUsage(start, end)
	if err != nil {
		return err
	}
	m.usages = usages
	return nil
}

func (m Model) getDateRange() (time.Time, time.Time) {
	var start time.Time
	now := time.Now().In(m.Config.Site.Location)
	if now.Day() < m.Config.BillStartDay {
		start = time.Date(now.Year(), now.Month()-1, m.Config.BillStartDay, 0, 0, 0, 0, m.Config.Site.Location)
	} else {
		start = time.Date(now.Year(), now.Month(), m.Config.BillStartDay, 0, 0, 0, 0, m.Config.Site.Location)
	}

	return fleetdb.GetDateRange(fleetdb.BillingRange, start)
}

func (m Model) usageReport() (string, error) {
	b := strings.Builder{}
	site := m.Config.Site

	type analysis struct {
		Tariff          *fleetdb.Tariff
		Season          *fleetdb.TariffSeason
		HomeUsage       float64
		GridUsage       float64
		SolarProduction float64
	}

	start, end := m.getDateRange()
	tariffMap := map[string]analysis{}
	for _, t := range site.Tariffs {
		season := t.FindSeason(start)
		tariffMap[t.Name] = analysis{
			Tariff: &t,
			Season: season,
		}
	}

	for _, eu := range m.usages {
		t, ok := tariffMap[eu.Tariff.Name]
		if !ok {
			m.Config.Logger.Error("Error getting tariff for result - skipping", slog.String("tariff", eu.Tariff.Name))
			continue
		}
		t.HomeUsage += eu.HomeUsage
		t.SolarProduction += eu.SolarProduction
		t.GridUsage += eu.GridUsage
		tariffMap[eu.Tariff.Name] = t
	}

	kwh := func(usage float64) float64 { return usage / 1000 }
	// cost returns the cost or credit for the given season and usage. First result is the label, Second is the cost/credit
	cost := func(season fleetdb.TariffSeason, usage float64) (string, float64) {
		if usage > 0 {
			return "Cost", season.BuyRate * kwh(usage)
		}
		return "Credit", 0 - (season.SellRate * kwh(usage))
	}

	b.WriteString(fmt.Sprintf("\nReporting from %s to %s\n", start.Format("2006-01-02"), end.Format("2006-01-02")))
	// show row for each tariff with home usage and solar production and how much it will cost
	for _, t := range tariffMap {
		usageLabel, cost := cost(*t.Season, t.GridUsage)
		b.WriteString(fmt.Sprintf("\nTariff: %s\n", t.Tariff.Name))
		b.WriteString(fmt.Sprintf("Season: %s\t Buy Rate: %.2f\tSell Rate: %.2f\n", t.Season.Name, t.Season.BuyRate, t.Season.SellRate))
		b.WriteString(fmt.Sprintf("Home Usage: %.2f kwh\n", kwh(t.HomeUsage)))
		b.WriteString(fmt.Sprintf("Grid Usage: %.2f kwh\t%s: %.2f\n", kwh(t.GridUsage), usageLabel, cost))
		b.WriteString(fmt.Sprintf("Solar Production: %.2f kwh\n", kwh(t.SolarProduction)))
	}

	return b.String(), nil
}
