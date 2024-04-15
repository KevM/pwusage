package main

import (
	"fmt"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/lipgloss/table"
	"github.com/kevm/pw-usage/internal/monitor"

	"log/slog"
)

func main() {

	file, err := os.OpenFile("tui.log", os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	logger := slog.New(slog.NewTextHandler(file, &slog.HandlerOptions{}))

	poller := monitor.NewPowerwallApi("http://localhost:8675", logger)

	ch := poller.PollApi(time.Second * 20)
	col := monitor.NewPwCollector(logger)

	m := model{
		poller:    ch,
		collector: &col,
	}

	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		logger.Error("error starting tui", slog.Any("error", err))
		fmt.Printf("Error starting TUI: %v\n", err)
		os.Exit(1)
	}
}

type model struct {
	poller      <-chan monitor.PwApi
	collector   *monitor.PwCollector
	last_sample monitor.PwSample
}

func (m model) Init() tea.Cmd {
	return waitForChannelTransform(m.poller, m.collector.Collect)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case monitor.PwSample:
		m.last_sample = msg
		cmd := waitForChannelTransform(m.poller, m.collector.Collect)
		return m, cmd
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		}
	}

	return m, nil
}

func (m model) View() string {
	totals := table.New().
		Border(lipgloss.NormalBorder()).
		Width(40).
		BorderStyle(lipgloss.NewStyle().Foreground(lipgloss.Color("99"))).
		Headers("Totals", "Watt/Hr?").
		Row("Grid Imported", fmt.Sprintf("%.2f", m.collector.Total.GridImported)).
		Row("Grid Exported", fmt.Sprintf("%.2f", m.collector.Total.GridExported)).
		Row("Solar Production", fmt.Sprintf("%.2f", m.collector.Total.SolarProduction)).
		Row("Home Consumption", fmt.Sprintf("%.2f", m.collector.Total.HomeConsumption))
	totals.Render()

	imme := table.New().
		Border(lipgloss.NormalBorder()).
		Width(40).
		BorderStyle(lipgloss.NewStyle().Foreground(lipgloss.Color("102"))).
		Headers("Currently", "Watt/Hr?").
		Row("Grid", fmt.Sprintf("%.2f", m.collector.Immediate.Grid)).
		Row("Solar", fmt.Sprintf("%.2f", m.collector.Immediate.Solar)).
		Row("Home", fmt.Sprintf("%.2f", m.collector.Immediate.Home)).
		Row("Battery", fmt.Sprintf("%.2f", m.collector.Immediate.Battery)).
		Row("Battery Level", fmt.Sprintf("%.2f", m.collector.Immediate.StateOfCharge))

	imme.Render()

	return lipgloss.JoinVertical(lipgloss.Left, totals.Render(), imme.Render())
}

func waitForChannelTransform[T any, R any](c <-chan T, f func(T) R) tea.Cmd {
	return func() tea.Msg {
		result := <-c
		return f(result)
	}
}
