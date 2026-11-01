import type { ITheme } from '@xterm/xterm';
import type { AnsiColorKey, Preferences } from '@shared/contracts';

/*
 * xterm.js paints to a canvas and needs literal colours, so the ANSI palette lives here rather than
 * in CSS tokens. Base values come from the UI spec.
 */
const DARK_ANSI: Record<AnsiColorKey, string> = {
  black: '#182231',
  red: '#FF6070',
  green: '#35E69B',
  yellow: '#FFD166',
  blue: '#58A6FF',
  magenta: '#B48AFF',
  cyan: '#38D9F2',
  white: '#DCE6F2',
  brightBlack: '#5B6B82',
  brightRed: '#FF8591',
  brightGreen: '#6BF0B8',
  brightYellow: '#FFDF8F',
  brightBlue: '#85BFFF',
  brightMagenta: '#CDB0FF',
  brightCyan: '#74E6F8',
  brightWhite: '#F6FAFF'
};

const LIGHT_ANSI: Record<AnsiColorKey, string> = {
  black: '#101B2C',
  red: '#C5213A',
  green: '#047A5A',
  yellow: '#8A5A00',
  blue: '#1259B8',
  magenta: '#6D35D6',
  cyan: '#007C9C',
  white: '#5F7087',
  brightBlack: '#43536A',
  brightRed: '#D93A52',
  brightGreen: '#0A8F6B',
  brightYellow: '#A06A00',
  brightBlue: '#2A70CF',
  brightMagenta: '#8450E4',
  brightCyan: '#0092B5',
  brightWhite: '#7A8BA2'
};

const SURFACES: Record<Preferences['theme'], Pick<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'>> = {
  'ryft-dark': {
    background: '#030911',
    foreground: '#E7EFFA',
    cursor: '#00E5FF',
    cursorAccent: '#030911',
    selectionBackground: 'rgba(0,229,255,0.22)'
  },
  'ryft-midnight': {
    background: '#010308',
    foreground: '#E7EFFA',
    cursor: '#00E5FF',
    cursorAccent: '#010308',
    selectionBackground: 'rgba(0,229,255,0.22)'
  },
  'ryft-light': {
    background: '#FBFCFE',
    foreground: '#101B2C',
    cursor: '#007C9C',
    cursorAccent: '#FBFCFE',
    selectionBackground: 'rgba(0,124,156,0.22)'
  }
};

export function buildTerminalTheme(preferences: Pick<Preferences, 'theme' | 'ansiOverrides'>): ITheme {
  const ansi = preferences.theme === 'ryft-light' ? LIGHT_ANSI : DARK_ANSI;
  return { ...SURFACES[preferences.theme], ...ansi, ...preferences.ansiOverrides };
}

export const ANSI_DEFAULTS = DARK_ANSI;
