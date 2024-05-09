package tui

import (
	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
)

type KeyMap struct {
	Settings    key.Binding
	BatteryHold key.Binding
	Quit        key.Binding
	Help        key.Binding
}

// ShortHelp returns keybindings to be shown in the mini help view. It's part
// of the key.Map interface.
func (k KeyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Settings, k.BatteryHold, k.Help, k.Quit}
}

// FullHelp returns keybindings for the expanded help view. It's part of the
// key.Map interface.
func (k KeyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		k.ShortHelp(),
		k.ShortHelp(),
	}
}

var DefaultKeyMap = KeyMap{
	Settings: key.NewBinding(
		key.WithKeys("s"),
		key.WithHelp("s", "settings"),
	),
	BatteryHold: key.NewBinding(
		key.WithKeys("h"),
		key.WithHelp("h", "battery hold"),
	),
	Quit: key.NewBinding(
		key.WithKeys("q", "ctrl+c", "esc"),
		key.WithHelp("q", "quit"),
	),
	Help: key.NewBinding(
		key.WithKeys("?"),
		key.WithHelp("?", "help"),
	),
}

func (m Model) handleKeyMsg(keyMsg tea.KeyMsg) (tea.Model, tea.Cmd) {

	if m.help.ShowAll {
		m.help.ShowAll = false // toggle help view
		switch {               //override escape to only close help
		case keyMsg.String() == tea.KeyEscape.String():
			return m, nil
		}
	}

	switch {
	case key.Matches(keyMsg, m.keys.Help):
		m.help.ShowAll = !m.help.ShowAll
	case key.Matches(keyMsg, m.keys.Quit):
		return m, tea.Quit
	case key.Matches(keyMsg, m.keys.BatteryHold):
		return m, cmdize(ShowBatteryHold{})
	case key.Matches(keyMsg, m.keys.Settings):
		return m, cmdize(ShowSettings{})
	}

	return m, nil
}
