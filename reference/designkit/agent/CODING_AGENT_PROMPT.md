# Coding Agent Master Prompt — Build RYFT

You are a senior Electron/TypeScript engineer and product designer. Implement **RYFT**, a production-minded cross-platform SSH session manager and local terminal desktop app. Read `agent/VISUAL_FIDELITY_ADDENDUM.md` and `docs/UI_PIXEL_SPEC.md` first. They are the visual source of truth, alongside `docs/DESIGN_SYSTEM.md`, `docs/ARCHITECTURE.md`, `design-tokens/ryft.tokens.css`, and `assets/icons/ryft-icon.svg`. Use the included reference image for visual direction, but prioritize usability and implementation fidelity.

## Working rules
1. Inspect repository state and available tooling first. If repo is empty, scaffold it. Provide a brief implementation plan, then implement rather than stopping at mockups.
2. Use Electron + React + TypeScript + Vite; Tailwind + Radix primitives; xterm.js, ssh2, node-pty, SQLite, Zustand, Zod. Verify current compatible versions before pinning.
3. Implement actual SSH and local PTY sessions, **not simulated terminal output**. Secure host-key verification and credential handling are mandatory.
4. Never place SSH secrets in frontend state persistence, logs or plaintext database. Use OS keychain and safe secret references; key paths may be stored but not key material. Never disable host key verification.
5. Electron renderer is untrusted: contextIsolation on, nodeIntegration off, typed minimal preload bridge, strict IPC validation, no shell command interpolation, CSP.
6. Match brand: deep navy surfaces, cyan focus/action, purple remote status, crisp typography, restrained glow. Use semantic tokens and reusable UI components; no inline hardcoded brand colors scattered across JSX.
7. Build desktop UX: resizable host sidebar, activity rail, search, groups, favorites, host CRUD, terminal tabs, split panes, session status, command palette, settings and empty/error/loading states.
8. Implement connection lifecycle, reconnection errors, terminal resize, clipboard behavior, disposal and listener cleanup. Support Windows/macOS/Linux where feasible, documenting platform caveats.
9. Add tests for host CRUD, session state transitions, IPC validation and secure credential references; integration tests for PTY lifecycle, mock SSH server or safe fixture. Avoid relying on live production hosts.
10. Include README with setup, dev, build, troubleshooting, security model and packaging. Generate platform icons from supplied SVG/PNGs where needed.

## Implementation phases
**Phase 1**: scaffold, design tokens, app shell, component library, icon, theme and test setup.
**Phase 2**: host/group database, host editor, search/favorites, keychain abstraction, SSH trust UI.
**Phase 3**: real local PTY, real SSH connection, xterm integration, session lifecycle, terminal tabs and splits.
**Phase 4**: command palette, settings, accessibility, robust errors, tests, packaging.

At the end of each phase run typecheck, lint and tests; fix failures before proceeding. Maintain a concise progress log and list any genuine blockers. Do not claim features are complete if stubbed. Keep SFTP, port forwarding and AI integrations out of MVP unless all MVP acceptance criteria pass.

## Definition of done
The user can save a host, verify its fingerprint, connect with key/agent/password, run commands, open a local shell, split and close terminals, restart app and retain non-secret host metadata. No passwords appear in logs or SQLite. Keyboard controls work and packaged build launches.

Start implementing now.
