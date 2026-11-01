# RYFT Architecture

Electron main process owns SSH, local PTY, storage and credential access. Renderer has **no** direct Node access. Preload exposes a typed, allowlisted API over IPC. Use `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where compatible; CSP and no remote content. Validate every IPC payload with Zod and authorize calls against application state.

Stack: Electron, TypeScript, React, Vite, Tailwind, Radix UI, xterm.js + fit addon, ssh2, node-pty, SQLite (via maintained binding), Zustand, Zod, Vitest and Playwright. Pin versions after compatibility checks. Native modules must be rebuilt for Electron and packaged per platform.

Data: hosts(id,name,hostname,port,username,authMethod,keyReference,groupId,tags,favorite,createdAt,updatedAt), groups, preferences, sessionHistory (metadata only). Never store passwords, passphrases, or private key contents in plaintext SQLite. Store secrets in OS credential vault; allow user-selected SSH key paths, protect paths and metadata, never silently upload them. Encrypt exports containing secrets only with explicit opt-in and a strong passphrase.

Session lifecycle: disconnected -> connecting -> authenticating -> connected -> reconnecting/failed -> closed. Each terminal pane has a stable session id, independent PTY/SSH channel, resize propagation, output stream and disposal. Apply backpressure; prevent output accumulation and leaking listeners. Host-key checking must use known_hosts or explicit first-use trust UI, show fingerprint and reject unexpected changes by default. No insecure accept-all setting as default.

Suggested modules: src/main/{ipc,ssh,pty,storage,security}, src/preload, src/renderer/{components,features,styles}, src/shared/{contracts,types}. Use explicit interfaces for session adapters.

MVP acceptance: create/edit/delete/group/search hosts; secure auth via SSH agent/key/password; connect/disconnect SSH; local shell; tabs; horizontal/vertical splits; terminal resize; persistence; keyboard palette; settings; error states; test suite; build instructions. SFTP and tunnels are later milestones, not fake MVP features.
