package tui

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/kevm/pw-usage/internal/tui/settings"
)

type ShowSettings struct{}
type UpdateUsageEvt struct{}
type UpdateUsageCmd struct {
	Usages []fleetdb.UsageData
}
type UpdateStatus struct {
	Message string
}

type Model struct {
	Config *config.Config

	settingsModel *settings.Model
	usages        []fleetdb.UsageData
	status        string
	background    chan tea.Msg
}

func NewModel(config *config.Config) *Model {
	return &Model{
		Config:     config,
		background: make(chan tea.Msg, 1),
	}
}

func (m Model) Init() tea.Cmd {
	if m.Config.Site == nil {
		return cmdize(ShowSettings{})
	} else {
		return cmdize(UpdateUsageEvt{})
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case UpdateStatus:
		m.status = msg.Message
		cmd := tea.Every(30*time.Second, func(t time.Time) tea.Msg { return UpdateStatus{Message: ""} }) //reset status to blank after 30 seconds
		return m, cmd
	case ShowSettings:
		m.settingsModel = settings.NewModel(m.Config)
		return m, m.settingsModel.Init()
	case UpdateUsageEvt:
		cmd := m.loadUsages()
		tickUsages := tea.Every(5*time.Minute, func(t time.Time) tea.Msg { return UpdateUsageEvt{} }) // update usage every 5 minutes
		return m, tea.Batch(cmd, tickUsages)
	case UpdateUsageCmd:
		m.usages = msg.Usages
		return m, cmdize(UpdateStatus{Message: "Usages updated."})
	case settings.SettingsUpdated:
		cmds := []tea.Cmd{}
		// update config
		m.Config.BillStartDay = msg.BillingStartDay
		cmd := m.loadSite(msg.SiteId)
		cmds = append(cmds, cmd)

		// save config
		err := m.Config.SaveToDotFiles()
		if err != nil {
			m.Config.Logger.Error("Error saving settings to dotfiles", slog.Any("error", cmd))
			cmds = append(cmds, cmdize(UpdateStatus{Message: "Error saving settings"}))
		}

		m.settingsModel = nil
		cmds = append(cmds, cmdize(UpdateUsageEvt{}))
		return m, tea.Batch(cmds...)
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

	report, err := m.usageReport()
	if err != nil {
		return fmt.Sprintf("Error generating usage report: %s", err)
	}

	r, _ := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		// glamour.WithWordWrap(80), //default 80
	)

	if m.status != "" {
		report += fmt.Sprintf("\n\n> **Status:** %s", m.status)
	}
	mdreport, _ := r.Render(report)
	return mdreport
}

func (m *Model) loadSite(siteid string) tea.Cmd {
	repo := fleetdb.NewEnergyRepo(m.Config.Database, m.Config.Logger)
	site, err := repo.LoadSite(siteid, m.Config.Client)
	if err != nil {
		return cmdize(UpdateStatus{Message: fmt.Sprintf("Error loading site info: %s", err)})
	}
	m.Config.Site = site
	return nil
}

func (m Model) loadUsages() tea.Cmd {
	go func() {
		err := fleetdb.NewImporter(m.Config.Database, m.Config.Client, m.Config.Logger).LoadSiteEnergyData(m.Config.Site)
		if err != nil {
			m.Config.Logger.Error("Error loading site energy data", slog.Any("error", err))
			m.background <- UpdateStatus{Message: "Error loading site energy data"}
			return
		}

		start, end := m.getDateRange()
		usage := fleetdb.NewUsage(m.Config.Site, m.Config.Database, m.Config.Client, m.Config.Logger)
		usages, err := usage.GetEnergyUsage(start, end)
		if err != nil {
			m.Config.Logger.Error("Error getting energy usage", slog.Any("error", err))
			m.background <- UpdateStatus{Message: fmt.Sprintf("Error getting energy usage: %s", err)}
			return
		}
		m.background <- UpdateUsageCmd{Usages: usages}
	}()

	return tea.Batch(cmdize(UpdateStatus{Message: "Loading site usage..."}), waitForChannel(m.background))
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

	b.WriteString(fmt.Sprintf("# %s\n", site.Name))

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

	b.WriteString(fmt.Sprintf("## Time of Use Report\n\n- billing period from %s to %s\n", start.Format("2006-01-02"), end.Format("2006-01-02")))
	// show row for each tariff with home usage and solar production and how much it will cost
	for _, t := range tariffMap {
		usageLabel, cost := cost(*t.Season, t.GridUsage)
		b.WriteString(fmt.Sprintf("### Tariff %s season %s\n", t.Tariff.Name, t.Season.Name))
		b.WriteString(fmt.Sprintf("* Buy rate $%.2f / kwh\n* Sell rate $%.2f / kwh\n", t.Season.BuyRate, t.Season.SellRate))
		b.WriteString(fmt.Sprintf("* Home Usage: %.2f kwh\n", kwh(t.HomeUsage)))
		b.WriteString(fmt.Sprintf("* Solar Production: %.2f kwh\n", kwh(t.SolarProduction)))
		b.WriteString(fmt.Sprintf("* Grid Usage: %.2f kwh\n* %s: $%.2f\n", kwh(t.GridUsage), usageLabel, cost))
	}

	return b.String(), nil
}

func cmdize[T any](t T) tea.Cmd {
	return func() tea.Msg {
		return t
	}
}

func waitForChannel(c chan tea.Msg) tea.Cmd {
	return func() tea.Msg {
		return <-c
	}
}
