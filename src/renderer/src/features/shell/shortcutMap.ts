export type ShortcutAction =
  | 'palette'
  | 'localTerminal'
  | 'closeTab'
  | 'splitRight'
  | 'splitDown'
  | 'nextTab'
  | 'previousTab'
  | 'nextPane'
  | 'previousPane';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Inside a terminal, plain Ctrl+K/T/W mean something to the shell (kill-line, transpose, delete-word),
 * so `capturePlain` is a preference there. The Shift variants have no shell meaning and always work.
 */
export function resolveShortcut(event: KeyLike, isMac: boolean, capturePlain: boolean): ShortcutAction | null {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.altKey && primary) {
    if (key === 'arrowright' || key === 'arrowdown') return 'nextPane';
    if (key === 'arrowleft' || key === 'arrowup') return 'previousPane';
    return null;
  }
  if (event.altKey) return null;
  if (event.ctrlKey && key === 'tab') return event.shiftKey ? 'previousTab' : 'nextTab';
  if (!primary) return null;
  if (event.shiftKey) {
    switch (key) {
      case 'd':
        return 'splitRight';
      case 'e':
        return 'splitDown';
      case 'p':
        return 'palette';
      case 't':
        return 'localTerminal';
      case 'w':
        return 'closeTab';
      default:
        return null;
    }
  }
  // macOS Cmd shortcuts never collide with the shell, which reads Ctrl.
  if (!capturePlain && !isMac) return null;
  switch (key) {
    case 'k':
      return 'palette';
    case 't':
      return 'localTerminal';
    case 'w':
      return 'closeTab';
    default:
      return null;
  }
}
