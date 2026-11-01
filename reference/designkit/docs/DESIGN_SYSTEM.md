# RYFT Design System v1

## Brand
RYFT — One Terminal. Every System. Visual metaphor: a portal/rift connecting local and remote shells. Cyberpunk precision, not decorative noise. The supplied icon is a **vector interpretation** of the concept and editable in SVG.

## Colors
| Token | Hex | Usage |
|---|---|---|
| bg.canvas | `#080F1A` | App background |
| bg.surface | `#111B2B` | Sidebars/cards |
| bg.elevated | `#19263A` | Popovers |
| border.default | `#293A50` | Borders |
| text.primary | `#F2F6FF` | Primary text |
| text.muted | `#9AAAC0` | Secondary text |
| accent.cyan | `#00E5FF` | Focus, primary actions |
| accent.purple | `#9B5CFF` | Remote connections |
| accent.pink | `#FF4C9A` | Rare accents |
| status.success | `#10D6A0` | Connected |
| status.warning | `#FFB020` | Reconnecting |
| status.error | `#FF5263` | Errors |

## Typography
UI: Inter, fallback system-ui. Terminal: JetBrains Mono, fallback monospace. Base UI 14px, terminal 13-15px configurable. Use font weights 400/500/600.

## Geometry
Spacing scale 4/8/12/16/24/32px; corner radii 6px controls, 10px panels, 14px dialogs. Focus ring 2px cyan with accessible contrast. Borders 1px. Do not use glows behind text.

## Layout
Activity rail 56px; hosts sidebar 260-320px resizable; workspace flex 1. Session tab bar 40px. Optional inspector 300px. Terminal canvas has 12px padding. Responsive minimum window 960x600; panels collapse gracefully.

## Components
ActivityRail, HostTree, HostCard, HostEditorDialog, CredentialPicker, ConnectionStatus, SessionTab, TerminalPane, SplitWorkspace, CommandPalette, EmptyState, Toast, ConfirmDialog, SettingsPanel. Define hover, active, disabled, focus, loading, error and keyboard behavior for each.

## Interaction
Ctrl/Cmd+K palette; Ctrl/Cmd+T new local terminal; Ctrl/Cmd+W close tab with confirmation if running process; Ctrl/Cmd+Shift+D split right; Ctrl/Cmd+Shift+E split down. All shortcuts editable eventually. Distinguish local vs SSH visually without relying only on color. Terminal copy/paste must respect platform conventions.

## Motion and accessibility
120-180ms transitions for panels, never animate terminal text or input. Respect prefers-reduced-motion. Minimum 4.5:1 text contrast for ordinary text. Screen-reader labels, keyboard navigation, visible focus, high-contrast option.

## Theme tokens
Implement semantic CSS variables, not hard-coded colors in components. Start with Dark, then Midnight and Light. Terminal ANSI palette is separately configurable.
