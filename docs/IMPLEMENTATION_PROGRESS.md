# RYFT – Implementation Progress (MVP → v1.3)

Status log of the upgrade. `docs/PROGRESS.md` remains the log of the MVP. Everything listed as *verified* has been
executed; everything else is explicitly marked.

## Current phase

**v1.3 implementation complete; the gates of v1.0 to v1.3 are recorded below.** The work is committed and released through `main`.
`package.json` still says version 0.1.0, so release tags stay at `v0.1.N` while the feature milestones are named v1.0 to v1.3.

## Status

| Area | State |
| --- | --- |
| v1.0 Connectivity & Security | Completed, gate passed |
| v1.1 Productivity | Completed, gate passed with the open points listed there |
| v1.2 Developer Edition | Completed, gate passed with the open points listed there |
| v1.3 Built-in Snippet Library | Completed, gate passed with the open points listed there |
| In progress | Nothing |
| Pending | Running the app itself on Linux and macOS beyond the release smoke test; decision on the version number |

## Starting point (analysis of the MVP, commit `ef68f28`)

- **Stack:** Electron 45, electron-vite, React 19, TypeScript 5.9, zustand, radix-ui, cmdk, Tailwind 4, xterm 6, ssh2 1.17,
  node-pty 1.1, zod 4, `node:sqlite` (no native SQLite dependency, since the machine has no C++ toolchain), vitest 5, Playwright.
- **Main process:** `createServices()` wires repositories, secret vault and `SessionManager`, free of Electron so that tests run
  the real thing. `ipc/registry.ts` validates sender and input with zod before any handler runs; errors are generalized unless
  on an allow list.
- **Renderer:** `useApp` (hosts, preferences, dialogs) and `useWorkspace` (tabs, splits, panes). Terminals live in
  `terminalRegistry.ts` outside of React, with flow control through acknowledgements.
- **Security already present:** context isolation, sandbox, CSP, navigation lock, OS-backed vault through `safeStorage`,
  host-key verification on every connection, read-only use of `~/.ssh/known_hosts`.
- **Gaps against the brief at the start:** no SFTP, no forwarding, no auth profiles, no per-host options, one connection per pane only.

## Architectural decisions

| Decision | Reason |
| --- | --- |
| New connection layer `ssh/connection.ts` used by terminals, SFTP and tunnels | Authentication and per-hop host-key checks exist once |
| `ssh/connectionPool.ts`: one ref-counted connection per window and host for SFTP/tunnels | Closing a pane does not kill a tunnel; terminals keep their own connection so a transfer cannot delay typing |
| Local file access through `LocalFsScope` (home + natively granted folders, realpath-checked) | The renderer is untrusted: no generic file access over IPC |
| Transfers land under `.name.<id>.ryftpart` and are renamed at the end | Interruptions never leave truncated files or damage the replaced one |
| Host-key replacement through a server-side `changeId` (10 minutes valid) | The renderer can only accept the exact key that was actually presented |
| Vault canary (`keyLost`) | Lost OS key is reported as such and ciphertext is kept, instead of silently prompting forever |
| History only from shell integration reports, with a per-session nonce | Commands are never derived from keystrokes, so secret input and full-screen programs cannot be recorded |
| Workspace startup commands behind a preference, off by default | A saved command must not run on a server just because a layout was opened |
| Docker through the CLI with argument arrays, no Docker API socket | No dependency, respects the user's contexts, never opens an endpoint |
| A stopped WSL distribution is only started after confirmation | Booting it starts its services and containers as well |
| WSL and Docker shells on `LocalPtyAdapter` | One terminal infrastructure for all targets |
| `AiProvider` interface with `OllamaProvider`; endpoint re-checked in the main process | No assumption about a model; preferences alone cannot send text elsewhere |
| Session logs as JSONL files with an index in SQLite | Bounded memory, simple retention, structured export |
| Broadcast state in the renderer, targets explicit, reduced by disconnects only | New sessions can never join silently |
| Docker UI tests use `e2e/dockerStub.ts`; the real adapter has gated integration tests | Tests and screenshots must not touch or show real containers |

Full picture: [ARCHITECTURE.md](ARCHITECTURE.md).

## Database migrations

| Version | Content |
| --- | --- |
| 1 | MVP schema |
| 2 | `authProfiles`, `forwardProfiles`, `hosts.authProfileId`, `hosts.options` (JSON, defaults to `{}`) |
| 3 | `workspaces`, `snippets`, `commandHistory`, `managedKeys` |
| 4 | `sessionLogs` |
| 5 | `presetLibrary`, library columns on `snippets` including `risk` |

Backup `<db>.bak-v<N>` before migrating; each migration is a transaction; a newer database is refused instead of being damaged.

## Test results

Latest full run on Windows 11, Node 24.19, 2026-11-01, after the v1.3 code. All numbers come from actual runs. `tests/real`, the
`-t "real "` integration tests and the packaged run were last executed before v1.3 and were not repeated for it.

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `vitest run` (unit and integration, gated tests skipped) | 850 passed, 10 skipped |
| `tests/real` against real OpenSSH in WSL (`tests/fixtures/wsl-openssh.sh`), before v1.3 | 15/15 passed, including 512 MB streamed upload, jump hosts and the bash history hook |
| `tests/integration/developer.test.ts -t "real "` against real WSL, Docker and Ollama, before v1.3 | 11/11 passed; no container with the test label left afterwards |
| `playwright --project=e2e` (app, connectivity, productivity, developer, snippetLibrary) | 52/52 passed |
| `playwright --project=visual` (screenshots) | 8/8 passed |
| `playwright --project=packaged` after `npm run package:dir`, before v1.3 | 1/1 passed |
| `npm run check:docs` | passed |

Not executed: the app on Linux and macOS, zsh, a real system SSH agent, key installation on a real OpenSSH server (the test server's
home is a real account, so this deliberately stays limited to the in-process server).

### v1.0 release gate

| Gate item | Evidence | Result |
| --- | --- | --- |
| Credential storage | `tests/unit/security.test.ts`, restart test in `e2e/app.spec.ts` | passed |
| Host-key verification | unit tests, `e2e/app.spec.ts`, real OpenSSH | passed |
| SFTP upload, download, cancel | integration, real OpenSSH (512 MB streamed), `e2e/connectivity.spec.ts` | passed |
| Forwarding -L, -R, -D | -L in E2E; -R and -D in integration and real OpenSSH (not in E2E) | passed |
| Profiles persist | `e2e/connectivity.spec.ts` | passed |
| MVP functionality | `e2e/app.spec.ts` | passed |

### v1.1 release gate

| Gate item | Evidence | Result |
| --- | --- | --- |
| Workspaces persist, layouts restore | `tests/integration/productivity.test.ts`, `e2e/productivity.spec.ts` | passed |
| Snippets CRUD, search, execute, parameter expansion | unit, integration, E2E | passed |
| History excludes sensitive input | real PowerShell and bash, `read -s` test, bash hook over real OpenSSH | passed for these shells; **zsh unverified** |
| Autocomplete does not interfere | sequence parser tests, E2E suggestions | passed for the tested shells |
| Keys generated and assigned | integration; generated key accepted by Windows OpenSSH client | passed |
| Key installation on a server | in-process server only | passed there; **real OpenSSH unverified** |
| Jump hosts with per-hop verification | integration incl. cycles and middle failures; route with shell and SFTP plus declined second hop against real OpenSSH | passed; the real route used one server under two names, not separate machines |
| v1.0 still works | full v1.0 suites above | passed |

### v1.2 release gate

| Gate item | Evidence | Result |
| --- | --- | --- |
| Docker list and manage | real Docker in WSL with a labelled test container; UI in E2E with demo data | passed |
| Logs stream, interactive shells | real Docker | passed |
| WSL detected, sessions work | real WSL `Ubuntu-26.04`, `e2e/developer.spec.ts` | passed |
| Ollama models discovered and selected | real Ollama (model list, one generation cancelled after its first chunk); UI with a local test server | passed |
| AI commands need confirmation | `e2e/developer.spec.ts` | passed |
| Logging enable, export, disable | integration incl. SSH; E2E for recording, search and deletion | passed |
| Broadcast across selected terminals, instant disable | `e2e/developer.spec.ts` with local terminals | passed; not run across several real remote hosts |
| Everything else still works | full suites above | passed |

Remote Docker contexts over SSH or TLS were not available and are unverified. Docker Desktop on Windows was not available either.

### v1.3 release gate

| Gate item | Evidence | Result |
| --- | --- | --- |
| Import without duplicates or loss of user data | `tests/integration/snippetLibrary.test.ts`, restart in `e2e/snippetLibrary.spec.ts` | passed |
| Built-ins read-only; favorite and copy work | integration, E2E | passed |
| Compatibility, unknown when undetected | unit, integration; local PowerShell in E2E; SSH probe against the in-process server | passed; **no real remote host, Linux or macOS desktop** |
| Parameters, validation, quoting | `tests/unit/snippetLibrary.test.ts`, `tests/unit/snippetSafety.test.ts` | passed |
| Security classification | unit tests, including every preset's declared risk against the classifier | passed; a heuristic, not a guarantee |
| Inserting does not execute; execution confirmed | `e2e/snippetLibrary.spec.ts`, `e2e/productivity.spec.ts` | passed |
| Earlier functionality | full suites above | passed |

Preset content, one-off run on 2026-11-01. Each applicable preset was expanded for each shell, with sample values for required parameters:

| Check | Result |
| --- | --- |
| Expansion | 293/293 |
| `bash -n` in WSL `Ubuntu-26.04` (parses only) | 135/135 |
| Windows PowerShell 5.1 parser (parses only) | 99/99 |
| Read-only presets actually run: bash | 89 runs: 60 exit 0, 29 not |
| Read-only presets actually run: PowerShell 5.1 | 62 runs: 39 exit 0, none hiding an error, 23 not |
| Read-only presets actually run: cmd.exe | 30 runs: 14 exit 0, 16 not |

Every non-zero result was read. All come from the environment or the sample values: no Docker on Windows, no container or Compose file, `dig`,
`traceroute`, `last` and `iostat` not installed, no `sshd` or agent, or a directory given as a file. Three presets that contact an outside
address were not run (`net.http-headers`, `debug.http-timing`, `ps.http-headers`).

**Not verified by running:** presets classified `caution` or `danger` were parsed but never executed, on purpose. Nothing ran on macOS or
on a real remote host. A preset that exits non-zero here for an environmental reason has not shown that it does its job. The curated examples
named in the v1.3 brief were not available, so the library was written from scratch for this release.

## Security considerations

See the security model in [ARCHITECTURE.md](ARCHITECTURE.md). Limits that remain by design:

- `safeStorage` protects against other OS users and offline theft, not against malware running as the same user. On Linux without a
  keyring the vault refuses to store secrets.
- Session logs and command history are unencrypted on disk. Logs can contain secrets shown or echoed in a session.
- An AI endpoint on a private network address receives the text the user sends.
- Environment variables in the advanced host options are stored as plaintext; the form tells the user not to put secrets there.

## Dependencies and compatibility

No dependency was added or changed by the upgrade (`package.json` and `package-lock.json` are unchanged). Ollama and Docker are optional.
Node 24 or newer is required for `node:sqlite`. Feature availability depends on runtime detection, see the README platform table.

## Known bugs and limitations

- OS key persistence on Windows: in rare runs (1 of 8 E2E runs, no repro in 25 dedicated exits) Chromium's `Local State` lacked
  the OS key after the first session, so stored secrets became unreadable (`keyLost`). The exact cause of the missed flush is
  unproven. `will-quit` now waits up to 15 s for the key to be on disk when secrets exist. A hard crash in the first seconds of the
  very first launch can still lose the key; the user then sees the `keyLost` path and the ciphertext is kept.
- An upload interrupted by a lost connection cannot remove its `.ryftpart` file on the server.
- Replacing a file on a server without `posix-rename@openssh.com` unlinks the destination first, so a very short window exists.
- Session logs contain the redraw output of line editors, so a PowerShell line can read `echo deploy finecho deploy finished`.
- AI answers show a code fence as raw text next to the command card.
- An upgrade that retires a library entry also removes its favorite flag. Copies stay.
- Terminal detection over SSH describes a new login, not a shell started later in the terminal. WSL and Docker likewise.
- The risk classification reads command text. It can be wrong in both directions for scripts, aliases or programs it does not know.
- The broadcast bar repeats the label of tabs with the same name; the highlighted panes show which ones are meant.
- `tests/real` logs in as a real account when the fixture runs in WSL. Terminal tests there turn off `HISTFILE` first, after an earlier
  version of the jump host test wrote one line to `~/.bash_history` (removed again).

## Next steps

1. Run the suites on Linux and macOS, and test zsh and a real system agent.
2. Decide on the version number; `package.json` still says 0.1.0.
