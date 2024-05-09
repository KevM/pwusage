package hold

import (
	"fmt"
	"log/slog"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/kevm/bubbleo/navstack"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetapi"
	"github.com/kevm/pw-usage/internal/fleetdb"
)

type LoadBatteryState struct{}
type CreateHoldCmd struct{}
type HoldCreated struct {
	Hold fleetdb.BatteryHoldState
}
type StopHoldCmd struct{}
type HoldStopped struct{}

type BatteryState struct {
	Hold       *fleetdb.BatteryHoldState
	HoldActive bool
	Live       *fleetapi.EnergySiteLiveStatus
}

type Model struct {
	Config *config.Config

	form  *huh.Form
	state *BatteryState
}

func NewModel(config *config.Config) *Model {
	result := &Model{
		Config: config,
	}

	result.form = result.newForm()
	return result
}

func (m Model) Init() tea.Cmd {
	return cmdize(LoadBatteryState{})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case LoadBatteryState:
		m.state = m.loadBatteryState()
		if m.state == nil {
			// error loading hold state let someone know
			// TODO Add error communication
			return m, tea.Quit
		}
		m.form = m.newForm()
		return m, m.form.Init()
	case CreateHoldCmd:
		cmd := m.createHold()
		if cmd == nil {
			// error creating hold let someone know
			// TODO Add error communication
			return m, tea.Quit
		}
		m.state = nil
		pop := navstack.PopNavigationCmd()
		return m, tea.Sequence(pop, cmd)
	case StopHoldCmd:
		cmd := m.stopHold()
		if cmd == nil {
			// error creating hold let someone know
			// TODO Add error communication
			return m, tea.Quit
		}
		m.state = nil
		pop := navstack.PopNavigationCmd()
		return m, tea.Sequence(pop, cmd)
	case tea.KeyMsg:
		switch msg.String() {
		case "q":
			return m, tea.Quit
		}
	}

	cmds := []tea.Cmd{}
	form, cmd := m.form.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		m.form = f
	}
	cmds = append(cmds, cmd)

	if m.state != nil && m.form.State == huh.StateCompleted {
		confirm := m.form.GetBool("confirm")
		if confirm && m.state.HoldActive {
			cmds = append(cmds, cmdize(StopHoldCmd{}))
		} else if confirm && !m.state.HoldActive {
			cmds = append(cmds, cmdize(CreateHoldCmd{}))
		} else if !confirm {
			cmds = append(cmds, navstack.PopNavigationCmd())
		}
	}

	return m, tea.Batch(cmds...)
}

func (m Model) View() string {
	if m.state == nil {
		return "Loading battery details..."
	}

	status := "Normal operation"
	if m.state.HoldActive {
		status = fmt.Sprintf("Battery Hold started at %s", m.state.Hold.Started.Format("2006-01-02 15:04:05"))
	}

	kwh := func(usage float64) float64 { return usage / 1000 }

	template := `# Battery Hold
	- Status: %s
	- Home is using: %.1f kwh
	- Solar producing: %.1f kwh
	- Battery charge: %d%%
	- Battery %% reserved: %d%%`
	header := fmt.Sprintf(template, status, kwh(m.state.Live.GridPower), kwh(m.state.Live.SolarPower), int(m.state.Live.PercentageCharged), m.state.Hold.BatteryReserveAtStart)

	r, _ := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		// glamour.WithWordWrap(80), //default 80
	)
	md, err := r.Render(header)
	if err != nil {
		return fmt.Sprintf("Error rendering markdown: %s", err)
	}
	form := ""
	if m.form.State != huh.StateCompleted {
		form = m.form.View()
	}

	return lipgloss.JoinVertical(lipgloss.Left, md, form)
}

func (m Model) newForm() *huh.Form {

	if m.state != nil && m.state.HoldActive {
		//stop form
		return huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Affirmative("Stop battery hold").
					Negative("Do Nothing").Key("confirm"),
			),
		)
	}

	// start form
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Affirmative("Start battery hold").
				Negative("Do Nothing").Key("confirm"),
		),
	)

	return form
}

func (m Model) stopHold() tea.Cmd {
	bh := fleetdb.NewBatteryHold(m.Config.Database, m.Config.Client, m.Config.Logger)
	err := bh.StopHold(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error starting battery hold", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	return cmdize(HoldStopped{})
}

func (m Model) createHold() tea.Cmd {
	bh := fleetdb.NewBatteryHold(m.Config.Database, m.Config.Client, m.Config.Logger)
	hold, err := bh.StartHold(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error starting battery hold", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	return cmdize(HoldCreated{Hold: *hold})
}

func (m Model) loadBatteryState() *BatteryState {
	live, err := m.Config.Client.GetEnergySiteLiveStatus(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error getting energy site live status", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	bh := fleetdb.NewBatteryHold(m.Config.Database, m.Config.Client, m.Config.Logger)
	hold, err := bh.FindSiteHold(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error finding battery hold for site", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	if hold != nil {
		return &BatteryState{
			Hold:       hold,
			HoldActive: true,
			Live:       live,
		}
	}

	hold, err = bh.CalculateHold(m.Config.Site.Id)
	if err != nil {
		m.Config.Logger.Error("Error calculating battery hold for site", slog.String("site", m.Config.Site.Id), slog.Any("error", err))
		return nil
	}

	return &BatteryState{
		Hold:       hold,
		HoldActive: false,
		Live:       live,
	}
}

// func (m *Model) createNewSettings() SettingsUpdated {
// 	siteid := m.form.GetString("site")
// 	// for _, p := range m.products {
// 	// 	if p.SiteId == siteid {
// 	// 		m.SelectedProduct = &p
// 	// 		break
// 	// 	}
// 	// }

// 	// er := fleetdb.NewEnergyRepo(m.Config.Database, m.Config.Logger)
// 	// site, err := er.LoadSite(siteid, m.Config.Client)
// 	// if err != nil {
// 	// 	m.Config.Logger.Error("Error loading site info", "site", m.SelectedProduct.SiteId, "error", err)
// 	// 	return SettingsUpdated{}
// 	// }

// 	bs := m.form.GetString("billing_start")
// 	m.BillingStartDay, _ = strconv.Atoi(bs)

// 	return SettingsUpdated{
// 		SiteId:          siteid,
// 		BillingStartDay: m.BillingStartDay,
// 	}
// }

// func (m Model) newForm(products []Product) *huh.Form {
// 	// site select
// 	site_options := make([]huh.Option[string], len(products))
// 	for i, p := range products {
// 		option := huh.Option[string]{
// 			Key:   p.Name,
// 			Value: p.SiteId,
// 		}

// 		if m.SelectedProduct != nil && m.SelectedProduct.SiteId == p.SiteId {
// 			option = option.Selected(true)
// 		}

// 		site_options[i] = option
// 	}
// 	site := huh.NewSelect[string]().
// 		Key("site").
// 		Title("Select Site").
// 		Options(site_options...)

// 	// billing start day select
// 	start := fmt.Sprintf("%d", m.BillingStartDay)
// 	billing_day := huh.NewInput().
// 		Title("Billing Start Day Of Month").
// 		Key("billing_start").
// 		Value(&start).
// 		Validate(func(s string) error {
// 			if s == "" {
// 				return errors.New("required")
// 			}
// 			_, err := strconv.Atoi(s)
// 			if err != nil {
// 				return fmt.Errorf("must be a number")
// 			}
// 			return nil
// 		})

// 	form := huh.NewForm(
// 		huh.NewGroup(
// 			site,
// 			billing_day,
// 		),
// 	)
// 	return form
// }

// func (m Model) loadProducts() []Product {
// 	products, err := m.Config.Client.GetProducts()
// 	if err != nil {
// 		return nil
// 	}

// 	var result []Product
// 	for _, p := range products {
// 		result = append(result, Product{
// 			SiteId: fmt.Sprintf("%d", p.EnergySiteID),
// 			Name:   p.SiteName,
// 			Type:   p.ResourceType,
// 		})
// 	}

// 	return result
// }

func cmdize[T any](t T) tea.Cmd {
	return func() tea.Msg {
		return t
	}
}
