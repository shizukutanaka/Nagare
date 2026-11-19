'use strict';
/*
 * Nagare desktop shell. Loads the unmodified nagare.html in a locked-down
 * window: contextIsolation on, nodeIntegration off, sandbox on, no preload.
 * New windows and navigation away from nagare.html are blocked; http(s)
 * links are handed to the OS default browser. Only media permissions
 * (camera / microphone / screen capture) are granted, so WebRTC works.
 */
const { app, BrowserWindow, session, shell, desktopCapturer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_FILE = path.join(__dirname, '..', 'nagare.html');
const APP_URL = pathToFileURL(APP_FILE).href;
const APP_PATH = new URL(APP_URL).pathname;
const MEDIA_PERMISSIONS = new Set(['media', 'display-capture']);

function isAppUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && u.pathname === APP_PATH;
  } catch (e) {
    return false;
  }
}

function openExternalIfWeb(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url);
  } catch (e) { /* not a URL: ignore */ }
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(MEDIA_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => MEDIA_PERMISSIONS.has(permission));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] })
      .then(sources => callback(sources.length ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  }, { useSystemPicker: true });
}

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternalIfWeb(url);
  });
  contents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-attach-webview', e => e.preventDefault());
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'Nagare',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
