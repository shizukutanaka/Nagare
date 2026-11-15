'use strict';
/*
 * Nagare end-to-end test (Electron main process).
 *
 * Opens the real nagare.html in separate windows and drives the public
 * window.NAGARE API exactly like a user would:
 *   A broadcasts (fake camera) -> invite code -> B joins -> answer code ->
 *   A accepts -> video must flow to B and chat must round-trip.
 *   Then B relays -> invite -> C joins -> video must flow to C and chat
 *   from C must reach A through B.
 *
 * Checks are reported in two groups:
 *   [app]       everything the app controls (capture, codec, signaling,
 *               state machines). These must pass everywhere.
 *   [transport] checks that additionally need working UDP between the two
 *               peers. Some sandboxes forbid UDP sends entirely (sendto
 *               returns EPERM for every process, browsers included); there
 *               these fail while [app] checks still pass. On a normal
 *               machine or CI runner, everything passes.
 *
 * Exits 0 when every check passes, 1 otherwise, 2 on watchdog timeout.
 * Screenshots are written to docs/ (NAGARE_SHOT_DIR overrides).
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = process.env.NAGARE_SHOT_DIR || path.join(ROOT, 'docs');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.commandLine.appendSwitch('mute-audio');

const results = [];
function check(group, name, cond, extra) {
  results.push({ group, name, ok: !!cond, extra: extra || null });
  console.log((cond ? 'PASS' : 'FAIL') + '  [' + group + '] ' + name + (extra ? '  -- ' + extra : ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function js(win, code) { return win.webContents.executeJavaScript(code); }
async function snap(win) { return js(win, 'window.NAGARE.api.getSnapshot()'); }
async function tryUntil(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { /* page may still be loading */ }
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(300);
  }
}
async function waitUntil(label, fn, timeoutMs) {
  if (!await tryUntil(fn, timeoutMs)) throw new Error('timeout waiting for: ' + label);
}

let server = null;
function serve() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/nagare.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(path.join(ROOT, 'nagare.html')).pipe(res);
      } else { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function makeWindow(port, title) {
  const win = new BrowserWindow({
    width: 1120, height: 920, title,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) console.log('[' + title + ' console] ' + message);
  });
  await win.loadURL('http://127.0.0.1:' + port + '/nagare.html');
  await waitUntil(title + ' API ready', async () => js(win, '!!(window.NAGARE && window.NAGARE.api)'), 15000);
  await js(win, "window.NAGARE.api.setSettings({ stun: '' })");
  return win;
}

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
  console.log('screenshot: ' + name);
}

async function main() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(true));
  if (session.defaultSession.setDevicePermissionHandler) {
    session.defaultSession.setDevicePermissionHandler(() => true);
  }
  const port = await serve();

  // ---------- A: broadcaster ----------
  const A = await makeWindow(port, 'A-broadcaster');
  await js(A, "window.NAGARE.api.setName('Host-A')");
  await js(A, "window.NAGARE.api.startBroadcast({ source: 'camera', quality: '480p' })");
  const aPreview = await tryUntil(async () => (await snap(A)).localVideo.videoWidth > 0, 15000);
  check('app', 'A: local preview has video', aPreview, 'videoWidth=' + (await snap(A)).localVideo.videoWidth);

  const invite = await js(A, 'window.NAGARE.api.createInvite()');
  check('app', 'A: invite code created', typeof invite === 'string' && invite.startsWith('NG1.'), 'len=' + (invite && invite.length));

  // ---------- B: viewer ----------
  const B = await makeWindow(port, 'B-viewer');
  await js(B, "window.NAGARE.api.setName('Viewer-B')");
  const answer = await js(B, 'window.NAGARE.api.join(' + JSON.stringify(invite) + ')');
  check('app', 'B: answer code created', typeof answer === 'string' && answer.startsWith('NG1.'), 'len=' + (answer && answer.length));

  await js(A, 'window.NAGARE.api.acceptAnswer(' + JSON.stringify(answer) + ')');

  // Signaling correctness: both sides applied the remote description and
  // their ICE agents started checking the exchanged candidates.
  const signalingOk = await tryUntil(async () => {
    const sa = await snap(A); const sb = await snap(B);
    const aSess = sa.sessions.find(s => s.dir === 'down');
    const bSess = sb.sessions.find(s => s.dir === 'up');
    return aSess && bSess && aSess.sig === 'stable' && bSess.sig === 'stable' &&
      aSess.candCount > 0 && bSess.candCount > 0 &&
      (aSess.ice === 'checking' || aSess.ice === 'connected') &&
      (bSess.ice === 'checking' || bSess.ice === 'connected');
  }, 15000);
  const saNow = await snap(A); const sbNow = await snap(B);
  check('app', 'signaling applied on both sides; ICE checking with exchanged candidates', signalingOk,
    'A ice=' + (saNow.sessions[0] || {}).ice + ' B ice=' + (sbNow.sessions[0] || {}).ice);

  await shot(A, 'screenshot-broadcast.png');
  await shot(B, 'screenshot-watch.png');

  // ---------- transport-dependent checks ----------
  const connected = await tryUntil(async () => {
    const sa = await snap(A); const sb = await snap(B);
    return sa.sessions.some(s => s.dir === 'down' && s.state === 'connected') &&
           sb.upstream && sb.upstream.state === 'connected';
  }, 30000);
  check('transport', 'A<->B: peer connections connected (needs UDP between peers)', connected);
  if (!connected) {
    check('transport', 'B: remote video plays', false, 'skipped: no connection');
    check('transport', 'chat A<->B round-trip', false, 'skipped: no connection');
    check('transport', 'B relay -> C: video plays', false, 'skipped: no connection');
    check('transport', 'chat C<->A forwarded through relay', false, 'skipped: no connection');
    check('transport', 'audience count converges to 2', false, 'skipped: no connection');
    return;
  }

  const videoOk = await tryUntil(async () => (await snap(B)).remoteVideo.videoWidth > 0, 20000);
  let framesOk = false;
  if (videoOk) {
    const t1 = (await snap(B)).remoteVideo.currentTime;
    await sleep(1600);
    const sbv = (await snap(B)).remoteVideo;
    framesOk = sbv.videoWidth > 0 && sbv.currentTime > t1;
    check('transport', 'B: remote video is playing and frames advance', framesOk,
      'size=' + sbv.videoWidth + 'x' + sbv.videoHeight + ' t ' + t1.toFixed(2) + '->' + sbv.currentTime.toFixed(2));
  } else {
    check('transport', 'B: remote video is playing and frames advance', false, 'video never sized');
  }

  await js(A, "window.NAGARE.api.sendChat('hello from A')");
  const chatAB = await tryUntil(async () =>
    (await snap(B)).chat.some(c => c.text === 'hello from A' && c.from === 'Host-A'), 10000);
  await js(B, "window.NAGARE.api.sendChat('hi from B')");
  const chatBA = await tryUntil(async () =>
    (await snap(A)).chat.some(c => c.text === 'hi from B' && c.from === 'Viewer-B'), 10000);
  check('transport', 'chat A<->B round-trip', chatAB && chatBA, 'A->B=' + chatAB + ' B->A=' + chatBA);

  // ---------- C: viewer behind B's relay ----------
  const relayInvite = await js(B, 'window.NAGARE.api.createRelayInvite()');
  check('app', 'B: relay invite created', typeof relayInvite === 'string' && relayInvite.startsWith('NG1.'), 'len=' + (relayInvite && relayInvite.length));

  const C = await makeWindow(port, 'C-relay-viewer');
  await js(C, "window.NAGARE.api.setName('Viewer-C')");
  const answerC = await js(C, 'window.NAGARE.api.join(' + JSON.stringify(relayInvite) + ')');
  await js(B, 'window.NAGARE.api.acceptRelayAnswer(' + JSON.stringify(answerC) + ')');
  const relayConnected = await tryUntil(async () => {
    const sb = await snap(B); const sc = await snap(C);
    return sb.sessions.some(s => s.dir === 'down' && s.state === 'connected') &&
           sc.upstream && sc.upstream.state === 'connected';
  }, 30000);
  check('transport', 'B<->C: relay connection established', relayConnected);
  if (relayConnected) {
    await tryUntil(async () => (await snap(C)).remoteVideo.videoWidth > 0, 20000);
    const ct1 = (await snap(C)).remoteVideo.currentTime;
    await sleep(1600);
    const scv = (await snap(C)).remoteVideo;
    check('transport', 'C: relayed video is playing and frames advance',
      scv.videoWidth > 0 && scv.currentTime > ct1,
      'size=' + scv.videoWidth + 'x' + scv.videoHeight + ' t ' + ct1.toFixed(2) + '->' + scv.currentTime.toFixed(2));
    check('app', 'C: joined at depth 2', (await snap(C)).myDepth === 2, 'myDepth=' + (await snap(C)).myDepth);

    await js(C, "window.NAGARE.api.sendChat('hi from C')");
    const chatCA = await tryUntil(async () =>
      (await snap(A)).chat.some(c => c.text === 'hi from C' && c.from === 'Viewer-C'), 10000);
    await js(A, "window.NAGARE.api.sendChat('welcome C')");
    const chatAC = await tryUntil(async () =>
      (await snap(C)).chat.some(c => c.text === 'welcome C' && c.from === 'Host-A'), 10000);
    check('transport', 'chat C<->A forwarded through relay', chatCA && chatAC, 'C->A=' + chatCA + ' A->C=' + chatAC);

    const audienceOk = await tryUntil(async () => {
      const sa = await snap(A); const sb = await snap(B);
      return sa.viewers === 2 && sb.audienceTotal === 2;
    }, 25000);
    check('transport', 'audience: root counts 2 viewers and B hears the total', audienceOk);

    await shot(C, 'screenshot-relay.png');
    await shot(B, 'screenshot-relay-host.png');
  }
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.log('FAIL  global watchdog timeout');
    console.log(JSON.stringify({ ok: false, results }, null, 2));
    app.exit(2);
  }, 300000);
  try {
    await main();
  } catch (e) {
    check('app', 'flow completed without exception', false, String(e && e.message || e));
  }
  clearTimeout(watchdog);
  const failed = results.filter(r => !r.ok);
  const appFailed = failed.filter(r => r.group === 'app');
  console.log(JSON.stringify({
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    appFailed: appFailed.length,
    transportFailed: failed.length - appFailed.length
  }, null, 2));
  app.exit(failed.length === 0 ? 0 : 1);
});
