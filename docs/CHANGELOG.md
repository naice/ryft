# Changelog

## RYFT v1.0 — Connectivity & Security

### Added

- Reusable authentication profiles (password, private key, passphrase-protected key, agent).
- Advanced host options: timeouts, keepalive, reconnect policy, default remote folder, terminal type, encoding, environment
  variables, optional startup commands, SOCKS5/HTTP proxy.
- SFTP backend with streaming transfer queue, conflict handling, cancellation and retry.
- Port forwarding (`-L`, `-R`, `-D`) with profiles, port conflict detection and optional reconnect with backoff.
- Deliberate replacement of a changed host key.
- SFTP view with dual panes, breadcrumbs, filter, drag and drop, chmod, transfer queue and conflict dialog.
- Port Forwarding view with profiles and a live list of active tunnels.
- Auth profile management in the settings and advanced options in the host editor.

### Changed

- SSH connection handling moved into a layer shared by terminals, SFTP and tunnels.

### Fixed

- Retrying a transfer after a reconnect binds to the new connection after checking it reaches the same host.
- The loopback check no longer accepts names such as `127.evil.example`.

### Security

- On Windows, quitting waits briefly for the OS vault key to reach the disk, when secrets exist.
- Host keys are verified for every hop of a route, before any authentication.
- Local file access from the renderer is limited to the home folder and natively granted folders.
- Non-loopback listeners need explicit consent per forward.
- Detection of a lost OS vault key, keeping the ciphertext.

## RYFT v1.1 — Productivity

### Added

- Workspaces: save the current tabs, splits, panel sizes, hosts, folders and optional startup commands under a name; restore,
  rename, duplicate, delete, set a default, and export or import them as versioned JSON without secrets.
- Snippets: create, edit, search, favorite and categorize commands with `{{name}}` and `{{name:default}}` parameters; preview the
  expansion; insert into the active terminal or run on explicitly selected sessions.
- Command history with shell integration for PowerShell, bash and zsh; search, per-entry deletion, exclusion rules and a switch to
  turn it off.
- Suggestions for commands and snippets with fuzzy matching and keyboard navigation (Ctrl+Shift+Space).
- Key manager: generate ED25519 keys, import keys, show and copy public keys and fingerprints, assign keys to hosts, and install a
  public key on a server after explicit confirmation.
- Jump hosts: multi-hop routes for terminals, SFTP and tunnels, with the route shown in the pane header.

### Changed

- A connecting pane names the hop it is on, and a failed connection names the hop that failed.

### Fixed

- Windows OpenSSH refused generated keys because of inherited file permissions; they are now restricted to the owner.
- The setup script of the PowerShell integration no longer appears as the first history entry.

### Security

- Password prompts, secret input and alternate-screen programs never reach the history, because only commands reported by the shell
  integration are recorded; commands starting with a space and built-in secret patterns such as `$env:RYFT_PASSWORD = "..."` are skipped.
- Startup commands in workspaces do not run unless the user enables the setting, which is off by default.
- Multi-session snippet runs show the targets and the final command before anything is sent.
- Each hop's host key is verified on its own; declining one stops the route before the next hop is contacted. Cycles are rejected
  before any connection is made.
- Private keys are never displayed, get owner-only permissions, and existing files are never overwritten.
- Workspace exports cannot contain secrets, and imported files are validated against the versioned schema.

## RYFT v1.2 — Developer Edition

### Added

- Docker: finds a local or WSL-hosted CLI and its contexts; lists containers with image, status, ports and runtime; search and
  filter; start, stop, restart; streaming logs; details; interactive shells in the regular terminal.
- WSL: lists distributions with their state, opens any number of terminals in them, default distribution and start folder.
- AI assistant through a provider abstraction with Ollama as first provider: model discovery and selection, custom local endpoint,
  streaming, cancellation, and prepared tasks for commands, explanations, log analysis, troubleshooting, SSH config and Docker errors.
- Session logging: per-session recording, optional default, search, text and JSONL export, deletion, retention limits by age and size,
  and a recording indicator.
- Broadcast input: explicit target selection, persistent warning bar with target names and count, highlighted panes, instant disable
  with Ctrl+Shift+B, confirmation before sending a command.
- Navigation entries for Docker, session logs and AI assistant.

### Changed

- The session target model now covers local shells, SSH, WSL and Docker on the same terminal infrastructure.

### Fixed

- Dialogs no longer focus their close button on opening. Its tooltip made the first Escape close only the tooltip.
- Dialogs return the focus to the element that opened them.
- A WSL binary that is missing is no longer reported as available.
- BOM handling when reading the UTF-16 output of `wsl.exe`.

### Security

- The AI assistant is off until enabled, only accepts local and private network endpoints, and only receives text the user sent or
  explicitly attached.
- AI answers never run by themselves. Inserting or running a suggested command shows the exact command for confirmation first.
- Answers are treated as untrusted text and have no path to privileged actions.
- Docker commands use argument arrays and validated identifiers. Unencrypted TCP contexts on other machines are refused.
- Stopping or restarting a container asks for confirmation.
- Session logging is off by default and records output, never keystrokes. Its limit, that output can contain secrets, is stated in the UI.
- New sessions never join a running broadcast, and sessions that disconnect leave it.

## RYFT v1.3 — Built-in Snippet Library

### Added

- Versioned built-in library of 178 snippets with stable ids: Linux system, networking, SSH, Docker, Git, troubleshooting, files and
  Windows PowerShell. Each entry declares shells, platforms, required tools, typed parameters and a risk level.
- Library browser under **Snippets → Bibliothek** with search, categories, descriptions, command preview, favorites, and risk and
  compatibility indicators.
- Compatibility check against the selected terminal's platform, shell and available tools. Anything undetected is shown as unknown.
- Typed snippet parameters (`text`, `integer`, `port`, `host`, `user`, `path`, `identifier`, `enum`, `url`) with required fields,
  defaults and per-field validation. The snippet editor can set them on personal snippets too.
- Duplicating a built-in entry into a personal, editable copy.
- Compatible library favorites in the terminal suggestions, and the remaining compatible entries once a query is typed.

### Changed

- The snippet dialog names the risk of the expanded command, which can be higher than the template's. **Einfügen** is the primary action.
- Running a dangerous command, or a modifying command on several sessions, requires ticking an acknowledgement in the confirmation.

### Security

- Parameter values are quoted per shell and for the quotes around their placeholder. Values a shell cannot safely receive are refused:
  a second shell re-parsing the command, double quotes inside `$()`, or characters Windows PowerShell mangles when passing to a program.
- Terminal detection only reads: system name, `$SHELL`, and `command -v` for known tool names.
- Built-in entries are read-only in the main process, not only in the UI.
