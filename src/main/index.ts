import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron';
import { Channels, EventChannels, SendChannels } from '@shared/channels';
import { createHandlers, createSendHandlers } from './ipc/handlers';
import { createDispatcher, createSenderCheck, type IpcCaller } from './ipc/registry';
import { configureLogFile, log } from './logger';
import { detectShells } from './pty/shells';
import { defaultSshDirectory } from './security/knownHosts';
import { OsSecretVault } from './security/secretVault';
import { createServices, type Services } from './services';
import { openDatabase } from './storage/database';

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererFileUrl = pathToFileURL(rendererFile).href;

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;

function isTrustedRendererUrl(url: string): boolean {
  if (devServerUrl) return url.startsWith(devServerUrl);
  return url.split(/[?#]/)[0] === rendererFileUrl;
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#060E18',
    title: 'RYFT',
    icon: join(__dirname, '../../resources/icon.png'),
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 8 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => window.show());
  window.on('maximize', () => window.webContents.send(EventChannels.windowMaximized, true));
  window.on('unmaximize', () => window.webContents.send(EventChannels.windowMaximized, false));

  // No in-app navigation and no popups: the app is a single trusted document.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const ownerId = window.webContents.id;
  window.on('closed', () => {
    services?.sessions.disposeOwner(ownerId);
    mainWindow = null;
  });
  // A reloaded or crashed renderer has lost its panes, so nothing could ever close their sessions again.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) services?.sessions.disposeOwner(ownerId);
  });
  window.webContents.on('render-process-gone', () => services?.sessions.disposeOwner(ownerId));

  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(rendererFile);
  return window;
}

function callerOf(event: IpcMainInvokeEvent | IpcMainEvent): IpcCaller {
  return { ownerId: event.sender.id, frameUrl: event.senderFrame?.url };
}

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function bootstrap(): void {
  const userData = app.getPath('userData');
  configureLogFile(join(userData, 'logs', 'ryft.log'));

  const shells = detectShells();
  const db = openDatabase(join(userData, 'ryft.sqlite'));
  const vault = new OsSecretVault(join(userData, 'secrets.vault.json'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    getSelectedStorageBackend: process.platform === 'linux' ? () => safeStorage.getSelectedStorageBackend() : undefined
  });

  services = createServices({
    db,
    secretStore: vault,
    shells,
    sink: {
      data: (event) => sendToWindow(EventChannels.sessionData, event),
      state: (event) => sendToWindow(EventChannels.sessionState, event),
      prompt: (event) => sendToWindow(EventChannels.sessionPrompt, event)
    }
  });

  const handlers = createHandlers(services, shells, {
    pickKeyFile: async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Privaten SSH-Schlüssel auswählen',
        defaultPath: defaultSshDirectory(),
        properties: ['openFile', 'showHiddenFiles']
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    minimizeWindow: () => mainWindow?.minimize(),
    toggleMaximizeWindow: () => {
      if (mainWindow?.isMaximized()) mainWindow.unmaximize();
      else mainWindow?.maximize();
    },
    closeWindow: () => mainWindow?.close(),
    appInfo: () => ({ platform: process.platform, version: app.getVersion(), homeSshDir: defaultSshDirectory() })
  });

  const dispatcher = createDispatcher(handlers, createSendHandlers(services), createSenderCheck(isTrustedRendererUrl));
  for (const channel of Object.values(Channels)) {
    ipcMain.handle(channel, (event, input: unknown) => dispatcher.invoke(channel, input, callerOf(event)));
  }
  for (const channel of Object.values(SendChannels)) {
    ipcMain.on(channel, (event, input: unknown) => dispatcher.send(channel, input, callerOf(event)));
  }
}

function hardenSession(): void {
  // The renderer never needs a device, notification or similar permission.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS routes Cmd+C/V/Q through the menu, so it needs the standard roles.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    hardenSession();
    installMenu();
    try {
      bootstrap();
    } catch (error) {
      log.error('Startup failed', { error });
      dialog.showErrorBox('RYFT konnte nicht starten', (error as Error).message);
      app.exit(1);
      return;
    }
    mainWindow = createWindow();
    app.on('activate', () => {
      if (!mainWindow) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => services?.sessions.disposeAll());
}
