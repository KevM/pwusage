package settings

import (
	"errors"
	"fmt"
	"strconv"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/kevm/pw-usage/internal/config"
	"github.com/kevm/pw-usage/internal/fleetdb"
)

type Product struct {
	SiteId string
	Name   string
	Type   string
}

type LoadProducts struct{}
type SettingsUpdated struct {
	SiteId          string
	BillingStartDay int
}

type Model struct {
	Config *config.Config

	SelectedProduct *Product
	BillingStartDay int
	products        []Product
	form            *huh.Form
}

func NewModel(config *config.Config) *Model {
	var selectedProduct *Product
	if config.Site != nil {
		selectedProduct = &Product{
			SiteId: config.Site.Id,
			Name:   config.Site.Name,
		}
	}

	result := &Model{
		Config:          config,
		SelectedProduct: selectedProduct,
		BillingStartDay: config.BillStartDay,
	}

	result.form = result.newForm(nil)
	return result
}

func (m Model) Init() tea.Cmd {
	return cmdize(LoadProducts{})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case LoadProducts:
		m.products = m.loadProducts()
		m.form = m.newForm(m.products)
		return m, m.form.Init()
	case tea.KeyMsg:
		switch msg.String() {
		case "q":
			return m, tea.Quit
		}
	}

	if m.form.State == huh.StateCompleted {
		settings := m.createNewSettings()
		return m, cmdize(settings)
	}

	form, cmd := m.form.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		m.form = f
	}

	return m, cmd
}

func (m Model) View() string {
	return m.form.View()
}

func (m *Model) createNewSettings() SettingsUpdated {
	siteid := m.form.GetString("site")
	for _, p := range m.products {
		if p.SiteId == siteid {
			m.SelectedProduct = &p
			break
		}
	}

	er := fleetdb.NewEnergyRepo(m.Config.Database, m.Config.Logger)
	site, err := er.LoadSite(siteid, m.Config.Client)
	if err != nil {
		m.Config.Logger.Error("Error loading site info", "site", m.SelectedProduct.SiteId, "error", err)
		return SettingsUpdated{}
	}

	bs := m.form.GetString("billing_start")
	m.BillingStartDay, _ = strconv.Atoi(bs)

	return SettingsUpdated{
		SiteId:          site.Id,
		BillingStartDay: m.BillingStartDay,
	}
}

func (m Model) newForm(products []Product) *huh.Form {
	// site select
	site_options := make([]huh.Option[string], len(products))
	for i, p := range products {
		option := huh.Option[string]{
			Key:   p.Name,
			Value: p.SiteId,
		}

		if m.SelectedProduct != nil && m.SelectedProduct.SiteId == p.SiteId {
			option = option.Selected(true)
		}

		site_options[i] = option
	}
	site := huh.NewSelect[string]().
		Key("site").
		Title("Select Site").
		Options(site_options...)

	// billing start day select
	billing_day := huh.NewInput().
		Title("Billing Start Day Of Month").
		Key("billing_start").
		Validate(func(s string) error {
			if s == "" {
				return errors.New("required")
			}
			_, err := strconv.Atoi(s)
			if err != nil {
				return fmt.Errorf("must be a number")
			}
			return nil
		})

	form := huh.NewForm(
		huh.NewGroup(
			site,
			billing_day,
		),
	)
	return form
}

func (m Model) loadProducts() []Product {
	products, err := m.Config.Client.GetProducts()
	if err != nil {
		return nil
	}

	var result []Product
	for _, p := range products {
		result = append(result, Product{
			SiteId: fmt.Sprintf("%d", p.EnergySiteID),
			Name:   p.SiteName,
			Type:   p.ResourceType,
		})
	}

	return result
}

func cmdize[T any](t T) tea.Cmd {
	return func() tea.Msg {
		return t
	}
}
