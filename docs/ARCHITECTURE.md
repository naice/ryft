# RYFT architecture

For people working on the code. It describes the state after v1.2. Usage is covered in [USER_GUIDE.md](USER_GUIDE.md), and test
results and open points in [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

## Overview

RYFT is local-first: there is no backend, and nothing leaves the machine except the connections the user opens. The Electron renderer
is treated as untrusted. All access to the network, files, processes and secrets happens in the main process, behind validated IPC.

```
Renderer (React, zustand, xterm)      untrusted, sandboxed, no Node
        │  typed bridge in src/preload (contextBridge)
        ▼
IPC registry (src/main/ipc)           checks sender and input with zod, generalizes errors
        ▼
Services (src/main/services.ts)       free of Electron, so tests run the real wiring
        ├─ SessionManager ─ adapters: LocalPtyAdapter (local, WSL, Docker), SshAdapter
        ├─ SshConnectionPool ─ SftpManager, TransferManager, ForwardManager, key install
        ├─ DockerService, WslService, AiService, SessionLogger, KeyManager
        └─ Repositories (node:sqlite) and HostSecrets (safeStorage)
```

## Modules

| Path | Responsibility |
| --- | --- |
| `src/shared/contracts.ts`, `channels.ts` | Channel names, zod schemas for every channel, shared types |
| `src/shared/features/*` | Per-feature schemas and pure rules (jump chains, snippets, history filter, broadcast targets, endpoint check) |
| `src/main/ipc` | `registry.ts` dispatches and validates; `handlers.ts` connects channels to services |
| `src/main/ssh` | `connection.ts` handles proxy, hops, host-key checks and authentication; `connectionPool.ts` shares connections |
| `src/main/sessions` | Session state machine, prompts, reconnect, observers |
| `src/main/pty` | Shell detection and the node-pty adapter |
| `src/main/sftp`, `forward` | Streaming transfers, tunnels |
| `src/main/workspaces`, `snippets`, `history`, `keys` | v1.1 features |
| `src/main/docker`, `wsl`, `ai`, `logging` | v1.2 features |
| `src/main/security` | Secret vault, credentials, known hosts, host-key changes |
| `src/main/storage` | Schema migrations and repositories |
| `src/renderer/src/features/*` | One folder per view or feature |
| `src/renderer/src/state` | `useApp`, `useWorkspace` and feature stores |
| `src/renderer/src/features/terminal/terminalRegistry.ts` | Terminals outside of React, with flow control through acknowledgements |

## IPC contract

- `Channels` in `src/shared/channels.ts` is the complete list. A unit test requires a schema for each channel.
- Handlers run only after sender and input validation. Errors reach the renderer in general form, unless they are on an allow list.
- There is no generic file access. Local paths pass `LocalFsScope` (home folder and folders granted through a native dialog, realpath
  checked). Key files, exports and imports go through native dialogs in the main process.
- RYFT has one main window, and events from the main process go to it. Resources belong to an `ownerId`, which identifies its webContents.

## Connections

Terminals have their own SSH connection, so that a transfer can never delay typing. SFTP, tunnels and key installation borrow a
reference-counted connection per window and host from `SshConnectionPool`. Closing a tab therefore never ends a tunnel, and a tunnel
never keeps a terminal alive.

A route is built by `flattenJumpChain`, which rejects cycles, missing hosts and overlong chains before anything connects. Each hop is
opened through the `direct-tcpip` channel of the previous one and goes through host-key verification and authentication on its own. A
configured proxy applies to the first hop only.

## Session targets

`SessionTarget` has four kinds: `local`, `ssh`, `wsl` and `docker`. All of them run on `SessionManager` and the same terminal code.
WSL and Docker shells use `LocalPtyAdapter` with `wsl.exe` or `docker exec` as an argument array, after a capability or state check in
`beforeStart`. Commands are never assembled as shell strings.

## Command history

Shells report commands through OSC sequences carrying a per-session nonce (`history/shellIntegration.ts`). `ShellIntegrationParser`
removes these sequences from the output, so that nothing appears on screen. Without a report, nothing is recorded. This is why password
prompts and full-screen programs cannot reach the history: RYFT never derives commands from keystrokes.

| Shell | Integration |
| --- | --- |
| PowerShell, bash (local) | Startup script through generated integration files |
| zsh (local) | `ZDOTDIR` forwarding |
| bash, zsh over SSH | A setup line sent after login, for hosts that opted in. Other POSIX shells ignore it. |
| Others | No history; snippets and manual use keep working |

## AI assistant

`AiProvider` (`src/main/ai/aiProvider.ts`) abstracts the backend; `OllamaProvider` is the only implementation. `AiService` refuses
everything until the preference is on and checks `isLocalEndpoint` again on every request, since preferences could have been changed
outside the UI. The context is limited to `MAX_AI_CONTEXT_CHARS` and contains only what the renderer sends after an explicit user
action. Answers go to the renderer as text. No path exists from an answer to a privileged action: commands reach a terminal only
through the regular input channel, after a confirmation that shows the exact command.

## Docker

`DockerService` runs the CLI with argument arrays, either directly or through `wsl.exe -d <distro>`. Container ids and context names are
validated by schema. Contexts with unencrypted TCP on another machine are shown with a warning and not used. Log streams are child
processes owned by a window and stopped with it.

## Session logs

`SessionLogger` writes JSONL events to `<userData>/session-logs/<id>.jsonl`; SQLite only holds the index. It receives terminal output
through the session observer and so never sees keystrokes. Writes are batched, and when the disk falls behind, events are dropped and
marked as `truncated` instead of filling the memory. Retention by age and total size runs on start and whenever a log ends; only
finished logs are deleted. Logs are not encrypted.

## Storage and migrations

SQLite through `node:sqlite`; schema version in `PRAGMA user_version`. Each migration runs in a transaction. Before migrating an
existing database, it is copied to `<db>.bak-v<N>`; an existing backup stays untouched. A database from a newer version is refused
and left unchanged.

| Version | Release | Content |
| --- | --- | --- |
| 1 | MVP | `groups`, `hosts`, `preferences`, `sessionHistory`, `trustedHostKeys` |
| 2 | v1.0 | `authProfiles`, `forwardProfiles`, `hosts.authProfileId`, `hosts.options` |
| 3 | v1.1 | `workspaces`, `snippets`, `commandHistory`, `managedKeys` |
| 4 | v1.2 | `sessionLogs` |

## Security model

| Threat | Measure |
| --- | --- |
| Compromised renderer | Context isolation, sandbox, no Node, CSP, navigation lock, denied window opening, validated IPC |
| Secrets at rest | `safeStorage` (DPAPI, Keychain, libsecret/kwallet). Linux without a keyring stores nothing. SQLite holds paths and references only. |
| Man in the middle | Host-key verification on every hop; it cannot be turned off. `known_hosts` is only read. |
| Tampered key replacement | The renderer can only accept a key the server actually presented, through a `changeId` valid for 10 minutes |
| Terminal output as an attack | AI answers and logs are text; nothing they contain is executed or followed |
| Accidental mass execution | Broadcast and multi-session snippets need explicit targets and a confirmation; new sessions never join |
| Command injection | Argument arrays for CLI tools; POSIX quoting for the one remote `cd` line; validated identifiers |

Limits: `safeStorage` does not protect against malware running as the same user. Session logs, command history and environment
variables in host options are stored unencrypted. Text sent to a model on a private network address leaves this computer.

## Shutdown lifecycle

`disposeOwner` runs when a window closes or reloads, `disposeAll` on `before-quit`. The order matters: users of a connection stop before
the connection itself.

1. AI requests are cancelled.
2. Docker log streams and their processes stop.
3. Transfers are cancelled; partial `.ryftpart` files are removed locally and, where the connection still exists, on the server.
4. Tunnels and SFTP sessions close and release their leases.
5. The connection pool closes what is left.
6. Terminal sessions and their processes end.
7. On `disposeAll`, session logs are flushed and closed.

On Windows, `will-quit` then waits up to 15 s until Chromium has written the OS key, if the vault holds secrets. A renderer crash or
reload runs the same owner cleanup.

## Cross-platform behavior

Features depend on detection, not on the platform name: `detectShells`, `findOnPath('docker')`, the WSL shell entry, the secret store
status. Something missing is shown as unavailable with an explanation. See the platform table in the README for what was executed where.

## Dependencies

The upgrade added **no** runtime or development dependency compared with the MVP. Ollama and Docker are optional external programs,
reached through HTTP and the CLI.

## Testing

- `tests/unit`: pure rules, schemas, renderer conventions (no color values in components).
- `tests/integration`: real services against the in-process SSH server `tests/fixtures/sshServer.ts`, real local shells, fake CLIs.
- `tests/real` and `real …` blocks in `tests/integration/developer.test.ts`: real OpenSSH, WSL, Docker and Ollama, only when the environment variables listed in the README are set.
- `e2e`: Playwright against the built app, with a temporary profile and `HOME`. The Docker view runs on `e2e/dockerStub.ts`, which replaces the IPC handlers with demo data, so that tests never touch containers on the machine.
