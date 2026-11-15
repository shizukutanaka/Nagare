'use strict';
/*
 * Launches the Electron E2E test under Xvfb.
 * Usage: node tests/e2e/run.js
 * Electron binary resolution order:
 *   $NAGARE_ELECTRON, <repo>/node_modules/.bin/electron,
 *   ~/workspace/tmp-work/electron-dist/electron
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const candidates = [
  process.env.NAGARE_ELECTRON,
  path.join(__dirname, '..', '..', 'node_modules', '.bin', 'electron'),
  path.join(os.homedir(), 'workspace', 'tmp-work', 'electron-dist', 'electron')
].filter(Boolean);
const electron = candidates.find(p => fs.existsSync(p));
if (!electron) {
  console.error('Electron binary not found. Set NAGARE_ELECTRON to its path.');
  process.exit(2);
}
console.log('electron: ' + electron);

const args = [path.join(__dirname, 'main.js')];
const env = Object.assign({}, process.env, { ELECTRON_DISABLE_SANDBOX: '1' });
const useXvfb = !process.env.DISPLAY;
const cmd = useXvfb ? 'xvfb-run' : electron;
const cmdArgs = useXvfb ? ['-a', '-s', '-screen 0 1280x1024x24', electron].concat(args) : args;

const child = spawn(cmd, cmdArgs, { env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) { console.error('killed by ' + signal); process.exit(2); }
  process.exit(code === null ? 2 : code);
});
