export type ClipboardAction = 'copy' | 'paste';

interface ClipboardKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * macOS uses Cmd, which the shell never sees. Windows follows its terminals: plain Ctrl+V pastes and
 * Ctrl+C copies only while something is selected, otherwise it stays SIGINT. On Linux plain Ctrl+C and
 * Ctrl+V keep their shell meaning (SIGINT, quoted insert), so only the Shift variants are clipboard keys.
 */
export function clipboardActionFor(event: ClipboardKey, platform: string, hasSelection: boolean): ClipboardAction | null {
  const mac = platform === 'darwin';
  const primary = mac ? event.metaKey : event.ctrlKey;
  if (!primary || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key !== 'c' && key !== 'v') return null;
  if (mac || event.shiftKey) return key === 'c' ? 'copy' : 'paste';
  if (platform !== 'win32') return null;
  if (key === 'v') return 'paste';
  return hasSelection ? 'copy' : null;
}
