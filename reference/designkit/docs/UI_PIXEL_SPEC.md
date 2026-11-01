# RYFT — Detailed Visual Specification v1.1

## Reference and scope
The approved reference is `assets/references/a_widescreen_promotional_ui_brand_moodboard_and_de.png` (1536×1024). Reproduce the CENTRAL APP MOCKUP (approximately x=14–1202, y=250–818), NOT the surrounding promotional moodboard. It is a concept image, not a literal screenshot: ignore garbled labels and fictitious terminal output. Create a functioning UI, never a static image.

## Visual direction
Dark, precise cyberpunk developer workstation. Almost-black blue surfaces, thin cyan outlines, restrained purple remote accents, high information density, sharp typography, subtle glows. Avoid generic dashboards, oversized padding, gradients everywhere, neon text overload, or thick rounded cards.

## Target viewport and shell
Baseline 1440×900, also test 1280×800 and 1920×1080. Electron min width 960, min height 600. Outer padding 12px, inter-panel gap 8px, 1px navy/cyan border, 10px radius. Three columns: (1) labeled left navigation 196px, (2) host browser 260px, resizable 220–380px, (3) remaining width terminal workspace, min 460px. At 1120–1439px use navigation 176px and hosts 240px; below 1120 collapse navigation to 60px icon rail. The mockup uses a LABELED sidebar, not only an icon rail.

## Navigation (left)
50px brand row, small RYFT icon + uppercase wordmark 18px 700 weight letter spacing 1.8px. Search field 32px with shortcut hint. 36px navigation rows with 16–18px Lucide icons, 12–13px labels, 6px corner radius. Selected row blue-purple translucent tint and 2px cyan left accent. Navigation: Hosts, Recent, Starred, Groups, Port Forwarding, SFTP, Local Terminal. Unimplemented SFTP/forwarding must be disabled or marked Coming Soon, not fake-functional. Bottom settings button; never fabricate personal account details.

## Host browser (middle)
Header 48px, `Hosts` title 16px/600, 28px circular cyan add button, overflow menu. Segmented filters `Alle / Favoriten / Gruppen`, 30px tall. Group headings 28px, expandable chevrons. Host rows 54px, leading 24px stacked-server icon with cyan/purple accents, primary name 12–13px/600, secondary IP 11px muted, trailing star. Selected host dark elevated fill and 2px cyan left rail; hover border and accessible action buttons. Context menu: Connect, Open in New Tab, Edit, Duplicate, Delete (confirmation). Editor fields: name, host, port, user, auth method, key reference, group, tags, favorite.

## Terminal workspace (right)
Top session tabs 38px high, each 124–220px wide, icon + ellipsized title + close, active tab slightly elevated with cyan top/bottom accent. `+` opens local terminal/session chooser. Terminal pane header 30px: connection status dot, host label, SSH/local label, split/maximize/close icons. Body background #030911, 12px padding, genuine xterm.js. Reference split arrangement: upper pane ~60% height, lower row ~40% with two equal panes; implement draggable splitters and persisted proportions. 6px split gutters, 2px grab zones. Active pane 1px cyan border; inactive subtle navy border. Remote purple accent, local cyan; status also conveyed in text/icon, never color only. Terminal font JetBrains Mono 13–14px, configurable. Never inject fake ASCII banner or fake SSH session text.

## Tokens
Canvas #080F1A; terminal #030911; nav #081321; host panel #101B2C; card #111F31; raised #17253A; border #1F344B; border hover #33506C; active border #00D6F5; text #F2F6FF; secondary #A2B0C6; muted #74859D; cyan #00E5FF; purple #9B5CFF; pink #FF4C9A; connected #10D6A0; warning #FFB020; error #FF5263. Use semantic CSS variables from `design-tokens/ryft.tokens.css`, not hardcoded JSX values. Border 1px; selected glow max 0 0 12px rgba(0,229,255,.12). Radii: chips 4px, controls 6px, cards 8px, major panels 10px. Spacing: 4, 8, 12, 16, 24, 32px.

## Typography
Inter for UI; JetBrains Mono for terminal. UI base 13px; headings 16px; metadata 11px. Line-height 18–20px UI, terminal 1.3. Use Lucide icons, not emoji. No glow on text. Font fallbacks required; verify redistribution license before bundling.

## Components
Buttons: primary cyan fill/navy text 32px, secondary navy fill/thin border, destructive red. Inputs 34px with visible cyan focus. Context menus dark elevated, 30px rows, keyboard navigable. Status badges show icon + text + color. Tooltips on icon-only controls. Toasts unobtrusive. Host key trust UI must show SHA256 fingerprint and block mismatches; never auto-trust. Passwords/keys stay out of frontend persistence and logs.

## Terminal ANSI palette
Background #030911; foreground #E7EFFA; cursor #00E5FF; selection rgba(0,229,255,.22). ANSI: black #182231, red #FF6070, green #35E69B, yellow #FFD166, blue #58A6FF, magenta #B48AFF, cyan #38D9F2, white #DCE6F2. Provide readable bright variants and user overrides.

## Motion, usability, accessibility
Hover 100–140ms, panel transitions 150–180ms. Never animate terminal glyphs or trigger layout shifts when tabs change. Respect reduced motion. Visible focus, keyboard navigation, readable contrast, native selection. Ensure PTY resizing when split panes resize, correct cleanup on tab close, and OS-specific clipboard conventions.

## Visual acceptance procedure
1. Produce REAL running-app screenshots at 1440×900, 1280×800 and 1920×1080, using harmless sample host records that are clearly disconnected.
2. Compare side by side against CENTRAL APP portion of the reference. Fix major mismatches in geometry, proportions, density, borders, fonts, color and split layout.
3. Also capture host editor, command palette, no-hosts empty state, and connection error.
4. Report visual differences, typecheck, lint, test and build results. Do not claim exact pixel parity because the reference is an illustrative AI image.
5. Never use the reference as a background image or fake a connected terminal.
