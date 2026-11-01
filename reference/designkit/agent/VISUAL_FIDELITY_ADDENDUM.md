# Coding Agent: Approved UI Fidelity Contract

The user explicitly chose `assets/references/a_widescreen_promotional_ui_brand_moodboard_and_de.png`. Read `docs/UI_PIXEL_SPEC.md` and inspect that image BEFORE implementation. Implement only its central application UI, not the surrounding design board. Import `design-tokens/ryft.tokens.css` and build reusable token-based components.

Priority: 1) three-column layout with labeled navigation, host groups and terminal workspace, 2) compact sizes and spacing, 3) deep navy surfaces and hairline cyan outlines, 4) tabbed and split terminals, 5) restrained purple/cyan accents, 6) polish. Use real xterm.js + node-pty + ssh2, not screenshot/fake sessions. Secure SSH host-key checking and keychain storage are non-negotiable.

Implement first the shell, tokens, HostTree, SessionTabs, TerminalPane and SplitWorkspace. Capture running app at 1440×900, 1280×800, 1920×1080 and compare to reference; iterate on proportions, typography, density and borders. If screenshots are unavailable, report that limitation and provide steps to capture them. Check empty/loading/error/focus/hover states, keyboard accessibility and reduced-motion. Do not stop at a mockup: finish functional MVP and tests per master prompt.

Checklist: labeled nav; grouped hosts; cyan active indicators; real terminal; adjustable split panes; session tabs; visible connection state; working host CRUD; genuine local and SSH connections; strict IPC; no plaintext secrets; screenshot comparison; typecheck/lint/tests/build.
