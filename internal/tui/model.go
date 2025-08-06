package tui

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/kevm/bubbleo/navstack"
	"github.com/kevm/bubbleo/window"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetapi"
	"github.com/kevm/pw-usage/internal/fleetdb"
	"github.com/kevm/pw-usage/internal/tui/hold"
	"github.com/kevm/pw-usage/internal/tui/settings"
)

type ShowSettings struct{}
type ShowBatteryHold struct{}
type UpdateUsageEvt struct{}
type UpdateUsageCmd struct {
	Usages []fleetdb.UsageData
}
type UpdateLiveEvt struct{}
type UpdateLiveCmd struct {
	Live fleetapi.EnergySiteLiveStatus
}
type UpdateHoldEvt struct{}
type UpdateStatus struct {
	Message string
	TTL     time.Duration
}

type Model struct {
	Config *config.Config

	usages     []fleetdb.UsageData
	live       fleetapi.EnergySiteLiveStatus
	status     string
	background chan tea.Msg
	keys       KeyMap
	help       help.Model
	width      int

	navstack *navstack.Model
	window   *window.Model
	hold     *fleetdb.BatteryHoldState
}

func NewModel(config *config.Config) *Model {
	w := window.New(120, 30, 0, 0)
	ns := navstack.New(&w).QuitOnEmptyStack(false)

	return &Model{
		Config:     config,
		background: make(chan tea.Msg, 1),
		keys:       DefaultKeyMap,
		help:       help.New(),

		window:   &w,
		navstack: &ns,
	}
}

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{}

	if m.Config.Site == nil {
		cmds = append(cmds, cmdize(ShowSettings{}))
	} else {
		cmds = append(cmds, cmdize(UpdateUsageEvt{}))
		cmds = append(cmds, cmdize(UpdateLiveEvt{}))
		cmds = append(cmds, cmdize(UpdateHoldEvt{}))
	}

	return tea.Batch(cmds...)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {

	if m.navstack.Top() != nil {
		// delegating to navstack when it has views
		cmd := m.navstack.Update(msg)
		return m, cmd
	}

	switch msg := msg.(type) {
	case UpdateStatus:
		m.status = msg.Message
		if m.status == "" {
			return m, nil
		}
		cmd := tea.Every(msg.TTL, func(_ time.Time) tea.Msg { return UpdateStatus{Message: ""} })
		return m, cmd
	case hold.HoldCreated:
		m.hold = &msg.Hold
		return m, cmdize(UpdateStatus{Message: "Hold started", TTL: 5 * time.Second})
	case ShowSettings:
		settingsModel := settings.NewModel(m.Config)
		item := navstack.NavigationItem{
			Title: "Settings",
			Model: settingsModel,
		}
		cmd := m.navstack.Push(item)
		return m, cmd
	case ShowBatteryHold:
		batteryHoldModel := hold.NewModel(m.Config)
		item := navstack.NavigationItem{
			Title: "Settings",
			Model: batteryHoldModel,
		}
		cmd := m.navstack.Push(item)
		return m, cmd
	case UpdateUsageEvt:
		cmd := m.loadUsages()
		tickUsages := tea.Every(5*time.Minute, func(_ time.Time) tea.Msg { return UpdateUsageEvt{} })
		return m, tea.Batch(cmd, tickUsages)
	case UpdateLiveEvt:
		cmd := m.loadLive()
		tickLive := tea.Every(30*time.Second, func(_ time.Time) tea.Msg { return UpdateLiveEvt{} })
		return m, tea.Batch(cmd, tickLive)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.window.Height = msg.Height
		m.window.Width = msg.Width
		m.help.Width = msg.Width
		return m, nil
	case UpdateHoldEvt:
		cmd := m.loadHold()
		return m, cmd
	case UpdateLiveCmd:
		m.live = msg.Live
		return m, cmdize(UpdateStatus{Message: "...", TTL: 1 * time.Second})
	case UpdateUsageCmd:
		m.usages = msg.Usages
		return m, cmdize(UpdateStatus{Message: "Usages updated.", TTL: 5 * time.Second})
	case settings.SettingsUpdated:
		cmds := []tea.Cmd{}
		// update config
		m.Config.BillStartDayOfMonth = msg.BillingStartDay
		cmd := m.loadSite(msg.SiteId)
		cmds = append(cmds, cmd)

		// save config
		err := m.Config.SaveToDotFiles()
		if err != nil {
			m.Config.Logger.Error("Error saving settings to dotfiles", slog.Any("error", cmd))
			cmds = append(cmds, cmdize(UpdateStatus{Message: "Error saving settings", TTL: 30 * time.Second}))
		}

		cmds = append(cmds, cmdize(UpdateUsageEvt{}), cmdize(UpdateLiveEvt{}))
		return m, tea.Batch(cmds...)
	case tea.KeyMsg:
		return m.handleKeyMsg(msg)
	}

	return m, nil
}

func (m Model) View() string {

	if m.navstack.Top() != nil {
		return m.navstack.View()
	}

	if m.help.ShowAll {
		return m.help.View(m.keys)
	}

	if m.Config.Site == nil {
		return "No site configured"
	}

	header := fmt.Sprintf("# %s\n", m.Config.Site.Name)

	live_report := m.liveReport()
	usage_report, err := m.usageReport()
	if err != nil {
		return fmt.Sprintf("Error generating usage report: %s", err)
	}

	r, _ := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		// glamour.WithWordWrap(80), //default 80
	)

	if m.status != "" {
		usage_report += fmt.Sprintf("\n\n> **Status:** %s", m.status)
	}
	mdreport, _ := r.Render(header + live_report + "\n" + usage_report)
	return mdreport
}

func (m *Model) loadSite(siteid string) tea.Cmd {
	repo := fleetdb.NewEnergyRepo(m.Config.Database, m.Config.Logger)
	site, err := repo.LoadSite(siteid, m.Config.Client)
	if err != nil {
		return cmdize(UpdateStatus{Message: fmt.Sprintf("Error loading site info: %s", err), TTL: 30 * time.Second})
	}
	m.Config.Site = site
	return nil
}

func (m Model) loadLive() tea.Cmd {
	go func() {
		live, err := m.Config.Client.GetEnergySiteLiveStatus(m.Config.Site.Id)
		if err != nil {
			m.background <- UpdateStatus{Message: fmt.Sprintf("Error loading site info: %s", err), TTL: 30 * time.Second}
		}

		m.background <- UpdateLiveCmd{Live: *live}
	}()

	return waitForChannel(m.background)
}

func (m *Model) loadHold() tea.Cmd {

	bh := fleetdb.NewBatteryHold(m.Config.Database, m.Config.Client, m.Config.Logger)
	hold, err := bh.FindSiteHold(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error finding battery hold for site", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	m.hold = hold
	return nil
}

func (m Model) loadUsages() tea.Cmd {
	go func() {
		err := fleetdb.NewImporter(m.Config.Database, m.Config.Client, m.Config.Logger).LoadSiteEnergyData(m.Config.Site)
		if err != nil {
			m.Config.Logger.Error("Error loading site energy data", slog.Any("error", err))
			m.background <- UpdateStatus{Message: "Error loading site energy data", TTL: 30 * time.Second}
			return
		}

		start, end := m.getDateRange()
		usage := fleetdb.NewUsage(m.Config.Site, m.Config.Database, m.Config.Client, m.Config.Logger)
		usages, err := usage.GetEnergyUsage(start, end)
		if err != nil {
			m.Config.Logger.Error("Error getting energy usage", slog.Any("error", err))
			m.background <- UpdateStatus{Message: fmt.Sprintf("Error getting energy usage: %s", err), TTL: 30 * time.Second}
			return
		}
		m.background <- UpdateUsageCmd{Usages: usages}
	}()

	statusCmd := cmdize(UpdateStatus{Message: "Loading site usage...", TTL: 30 * time.Second})
	waitCmd := waitForChannel(m.background)
	return tea.Batch(statusCmd, waitCmd)
}

func (m Model) getDateRange() (time.Time, time.Time) {
	var start time.Time
	t := m.Config.CurrentDate

	if t.Day() < m.Config.BillStartDayOfMonth {
		start = time.Date(t.Year(), t.Month()-1, m.Config.BillStartDayOfMonth, 0, 0, 0, 0, m.Config.Site.Location)
	} else {
		start = time.Date(t.Year(), t.Month(), m.Config.BillStartDayOfMonth, 0, 0, 0, 0, m.Config.Site.Location)
	}

	return fleetdb.GetDateRange(fleetdb.BillingRange, start)
}

func (m Model) liveReport() string {

	if m.live.Timestamp == "" {
		return "No live data..."
	}

	b := strings.Builder{}
	if m.hold != nil {
		b.WriteString(fmt.Sprintf("## Battery Hold\n\n- Started at %s\n", m.hold.Started.Format("2006-01-02 15:04:05")))
		b.WriteString(fmt.Sprintf("- Battery was at %d%% when the hold started.\n", m.hold.StartBatteryCharge))
		b.WriteString(fmt.Sprintf("- Reserve will be restored to %d%% when the hold is cancelled.\n", m.hold.BatteryReserveAtStart))
		b.WriteString("- press 'h' to cancel hold.\n\n")
	}

	updated, err := time.Parse(time.RFC3339, m.live.Timestamp)
	if err != nil {
		m.Config.Logger.Error("Error parsing timestamp from live status", slog.String("timestamp", m.live.Timestamp))
		updated = time.Now()
	}

	kwh := func(usage float64) float64 { return usage / 1000 }

	b.WriteString(fmt.Sprintf("## Live Data\n\n- Last updated at %s\n", updated.Format("2006-01-02 15:04:05")))
	b.WriteString(fmt.Sprintf("- Solar Production: %.2f kwh\n", kwh(m.live.SolarPower)))
	b.WriteString(fmt.Sprintf("- Home Usage: %.2f kwh\n", kwh(m.live.LoadPower)))
	b.WriteString(fmt.Sprintf("- Grid Usage: %.2f kwh\n", kwh(m.live.GridPower)))
	b.WriteString(fmt.Sprintf("- Battery Usage: %.2f kwh\n", kwh(m.live.BatteryPower)))
	b.WriteString(fmt.Sprintf("- Battery Charge: %d%%\n", int(m.live.PercentageCharged)))
	return b.String()
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
	analysisMapByTariff := map[string]analysis{}
	for _, t := range site.Tariffs {
		season := t.FindSeason(start)
		analysisMapByTariff[t.Name] = analysis{
			Tariff: &t,
			Season: season,
		}
	}

	// reduce the usages into analysis structs by tariff
	for _, eu := range m.usages {
		t, ok := analysisMapByTariff[eu.Tariff.Name]
		if !ok {
			m.Config.Logger.Error("Error getting tariff for result - skipping", slog.String("tariff", eu.Tariff.Name))
			continue
		}
		t.HomeUsage += eu.HomeUsage
		t.SolarProduction += eu.SolarProduction
		t.GridUsage += eu.GridUsage
		analysisMapByTariff[eu.Tariff.Name] = t
	}

	// create report string result

	kwh := func(usage float64) float64 { return usage / 1000 }
	// cost returns the cost or credit for the given season and usage. First result is the label, Second is the cost/credit
	cost := func(season fleetdb.TariffSeason, usage float64) (string, float64) {
		if usage > 0 {
			return "Cost", season.BuyRate * kwh(usage)
		}
		return "Credit", 0 - (season.SellRate * kwh(usage))
	}

	// Sort the map by tariff name
	var sortedTariffNames []string
	for name := range analysisMapByTariff {
		sortedTariffNames = append(sortedTariffNames, name)
	}
	sort.Strings(sortedTariffNames) // Sort the tariff names alphabetically

	b.WriteString(fmt.Sprintf("## Time of Use Report\n\n- billing period from %s to %s\n", start.Format("2006-01-02"), end.Format("2006-01-02")))
	// show row for each tariff with home usage and solar production and how much it will cost
	for _, name := range sortedTariffNames {
		t := analysisMapByTariff[name]
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
