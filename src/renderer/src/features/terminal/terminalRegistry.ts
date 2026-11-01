import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { Channels } from '@shared/channels';
import type { Preferences } from '@shared/contracts';
import { api } from '../../lib/api';
import { clipboardActionFor } from './clipboardKeys';
import { buildTerminalTheme } from './terminalTheme';

/** Acknowledge in steps: per-write IPC would itself become the bottleneck under heavy output. */
const ACK_STEP_CHARS = 64 * 1024;

export interface TerminalEntry {
  id: string;
  terminal: Terminal;
  /** Lives for as long as the pane, and moves between React containers so that the screen survives re-layouts. */
  element: HTMLDivElement;
  fit: FitAddon;
  webgl: WebglAddon | null;
  opened: boolean;
  pendingAck: number;
  live: boolean;
}

export interface TerminalCallbacks {
  /** Returns true when the key event was an app shortcut and must not reach the shell. */
  handleKey(event: KeyboardEvent): boolean;
  onFocus(id: string): void;
  platform(): string;
}

const entries = new Map<string, TerminalEntry>();
let callbacks: TerminalCallbacks | null = null;
let preferences: Preferences | null = null;
let keyMirror: ((sourceId: string, data: string) => void) | null = null;

/** Repeats key presses elsewhere. Pastes and the terminal's own replies to programs are not key presses, so they stay put. */
export function setKeyMirror(mirror: ((sourceId: string, data: string) => void) | null): void {
  keyMirror = mirror;
}

export function configureTerminals(next: TerminalCallbacks): void {
  callbacks = next;
}

function optionsFrom(prefs: Preferences): ITerminalOptions {
  return {
    fontFamily: prefs.terminalFontFamily,
    fontSize: prefs.terminalFontSize,
    lineHeight: prefs.terminalLineHeight,
    cursorStyle: prefs.terminalCursorStyle,
    cursorBlink: prefs.terminalCursorBlink,
    scrollback: prefs.terminalScrollback,
    theme: buildTerminalTheme(prefs),
    allowProposedApi: false,
    // A remote program must not be able to read the clipboard or the screen through escape sequences.
    windowOptions: {},
    rightClickSelectsWord: false
  };
}

function enableWebgl(entry: TerminalEntry): void {
  if (entry.webgl || preferences?.terminalRenderer !== 'webgl') return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      entry.webgl = null;
    });
    entry.terminal.loadAddon(addon);
    entry.webgl = addon;
  } catch {
    // No GPU context available: the built-in DOM renderer keeps working.
    entry.webgl = null;
  }
}

async function copySelection(entry: TerminalEntry): Promise<void> {
  const text = entry.terminal.getSelection();
  if (text) await api.invoke(Channels.clipboardWrite, { text });
}

export async function pasteInto(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry) return;
  const text = await api.invoke(Channels.clipboardRead);
  // terminal.paste applies bracketed paste, so multi-line content does not execute line by line.
  if (text) entry.terminal.paste(text);
}

export type InsertResult = 'ok' | 'not-live' | 'alternate-screen' | 'multiline-unsafe';

/** Why text cannot go into this terminal right now, or 'ok'. */
export function insertProblem(id: string, text: string): InsertResult {
  const entry = entries.get(id);
  if (!entry?.live) return 'not-live';
  // A full-screen program would read the text as key presses.
  if (entry.terminal.buffer.active.type === 'alternate') return 'alternate-screen';
  // Without bracketed paste, every line break would already run what stands before it.
  if (/[\r\n]/.test(text.replace(/[\r\n]+$/, '')) && !entry.terminal.modes.bracketedPasteMode) return 'multiline-unsafe';
  return 'ok';
}

/** Puts a command on the prompt. It only runs with `execute`, which is for callers that showed it and asked first. */
export function insertCommand(id: string, text: string, execute: boolean): InsertResult {
  const problem = insertProblem(id, text);
  const entry = entries.get(id);
  if (problem !== 'ok' || !entry) return problem;
  entry.terminal.paste(text.replace(/[\r\n]+$/, ''));
  if (execute) api.writeSession(id, '\r');
  return 'ok';
}

export function isAlternateScreen(id: string): boolean {
  return entries.get(id)?.terminal.buffer.active.type === 'alternate';
}

/** Read only when someone asks to attach it. */
export function selectionOf(id: string): string {
  return entries.get(id)?.terminal.getSelection() ?? '';
}

export function copyFrom(id: string): Promise<void> {
  const entry = entries.get(id);
  return entry ? copySelection(entry) : Promise.resolve();
}

export function hasSelection(id: string): boolean {
  return entries.get(id)?.terminal.hasSelection() ?? false;
}

function handleClipboardKey(entry: TerminalEntry, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  const platform = callbacks?.platform() ?? '';
  const action = clipboardActionFor(event, platform, entry.terminal.hasSelection());
  if (!action) return false;
  // preventDefault stops the browser's paste event, which would otherwise insert the text a second time.
  event.preventDefault();
  if (action === 'paste') {
    void pasteInto(entry.id);
  } else {
    void copySelection(entry);
    // Clearing it means that a second plain Ctrl+C on Windows is SIGINT again.
    if (platform === 'win32' && !event.shiftKey) entry.terminal.clearSelection();
  }
  return true;
}

export function ensureTerminal(id: string): TerminalEntry {
  const existing = entries.get(id);
  if (existing) return existing;
  if (!preferences) throw new Error('Terminal preferences are not loaded');

  const element = document.createElement('div');
  element.style.width = '100%';
  element.style.height = '100%';
  const terminal = new Terminal(optionsFrom(preferences));
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const entry: TerminalEntry = { id, terminal, element, fit, webgl: null, opened: false, pendingAck: 0, live: false };

  terminal.attachCustomKeyEventHandler((event) => {
    if (callbacks?.handleKey(event)) return false;
    return !handleClipboardKey(entry, event);
  });
  terminal.onData((data) => {
    if (entry.live) api.writeSession(id, data);
  });
  terminal.onKey(({ key }) => {
    if (entry.live) keyMirror?.(id, key);
  });
  terminal.onBinary((data) => {
    if (entry.live) api.writeSession(id, data);
  });
  terminal.onResize(({ cols, rows }) => {
    if (entry.live) api.resizeSession(id, cols, rows);
  });
  element.addEventListener('focusin', () => callbacks?.onFocus(id));

  entries.set(id, entry);
  return entry;
}

/** Attaches the persistent terminal element to a container; the first attach opens it. */
export function attachTerminal(id: string, container: HTMLElement): void {
  const entry = ensureTerminal(id);
  if (entry.element.parentElement !== container) container.appendChild(entry.element);
  if (!entry.opened) {
    entry.terminal.open(entry.element);
    entry.opened = true;
    enableWebgl(entry);
  }
  fitTerminal(id);
}

export function fitTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry?.opened || !entry.element.isConnected) return;
  const { clientWidth, clientHeight } = entry.element;
  // Hidden tabs measure 0; fitting then would shrink the remote PTY to nothing.
  if (clientWidth === 0 || clientHeight === 0) return;
  try {
    entry.fit.fit();
  } catch {
    // The renderer is not ready yet; the next resize fits again.
  }
}

export function terminalSize(id: string): { cols: number; rows: number } {
  const entry = ensureTerminal(id);
  return { cols: Math.max(entry.terminal.cols, 1), rows: Math.max(entry.terminal.rows, 1) };
}

export function focusTerminal(id: string): void {
  entries.get(id)?.terminal.focus();
}

export function setTerminalLive(id: string, live: boolean): void {
  const entry = entries.get(id);
  if (entry) entry.live = live;
}

export function clearTerminal(id: string): void {
  const entry = entries.get(id);
  entry?.terminal.reset();
}

export function writeToTerminal(id: string, data: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.terminal.write(data, () => {
    // The ack follows xterm's parser, which is what provides real backpressure to the source.
    entry.pendingAck += data.length;
    if (entry.pendingAck >= ACK_STEP_CHARS) {
      const chars = entry.pendingAck;
      entry.pendingAck = 0;
      if (entry.live) api.ackSession(id, chars);
    }
  });
}

export function disposeTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entry.webgl?.dispose();
  entry.terminal.dispose();
  entry.element.remove();
}

export function applyTerminalPreferences(next: Preferences): void {
  preferences = next;
  for (const entry of entries.values()) {
    entry.terminal.options = optionsFrom(next);
    if (next.terminalRenderer === 'webgl') {
      if (entry.opened) enableWebgl(entry);
    } else if (entry.webgl) {
      entry.webgl.dispose();
      entry.webgl = null;
    }
    fitTerminal(entry.id);
  }
}
