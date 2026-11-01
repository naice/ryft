import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { useBroadcast } from '../broadcast/broadcastStore';
import { useSnippets } from '../snippets/snippetStore';
import { resolveShortcut, type ShortcutAction } from './shortcutMap';

export function runShortcut(action: ShortcutAction): void {
  const broadcast = useBroadcast.getState();
  // Turning a broadcast off is the one thing that always works, whatever is open.
  if (action === 'broadcast' && broadcast.active) {
    broadcast.deactivate();
    return;
  }
  if (broadcast.dialogOpen) return;
  const app = useApp.getState();
  const workspace = useWorkspace.getState();
  // A dialog is modal: nothing may change behind it, for instance a tab closing under a host-key prompt.
  const snippets = useSnippets.getState();
  if (snippets.suggestionsFor !== null || snippets.running !== null) return;
  if (app.settingsOpen || app.editor !== null || app.confirm !== null || workspace.prompts.length > 0 || workspace.chooser !== null) return;
  if (app.paletteOpen && action !== 'palette') return;
  switch (action) {
    case 'palette':
      app.setPaletteOpen(!app.paletteOpen);
      break;
    case 'localTerminal':
      workspace.openTab({ kind: 'local', shellId: app.preferences?.defaultShellId ?? null });
      break;
    case 'closeTab':
      if (workspace.activeTabId) workspace.requestCloseTab(workspace.activeTabId);
      break;
    case 'splitRight':
      workspace.splitActive('row');
      break;
    case 'splitDown':
      workspace.splitActive('column');
      break;
    case 'nextTab':
      workspace.moveTab(1);
      break;
    case 'previousTab':
      workspace.moveTab(-1);
      break;
    case 'nextPane':
      workspace.cycleFocus(1);
      break;
    case 'previousPane':
      workspace.cycleFocus(-1);
      break;
    case 'suggest':
      snippets.openSuggestions();
      break;
    case 'broadcast':
      broadcast.setDialogOpen(true);
      break;
  }
}

/** Handles a key event raised inside xterm. Returns true when it was consumed as an app shortcut. */
export function handleTerminalKey(event: KeyboardEvent): boolean {
  const { info, preferences } = useApp.getState();
  const action = resolveShortcut(event, info?.platform === 'darwin', preferences?.captureTerminalShortcuts ?? true);
  if (!action) return false;
  if (event.type === 'keydown') {
    event.preventDefault();
    runShortcut(action);
  }
  return true;
}
