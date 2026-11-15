'use strict';
/*
 * Nagare core unit tests.
 * The core logic lives inside nagare.html (single-file product). These tests
 * extract the marked core block and run the exact shipped code — no copies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const html = fs.readFileSync(path.join(__dirname, '..', 'nagare.html'), 'utf8');
const startMark = '// === NAGARE CORE START ===';
const endMark = '// === NAGARE CORE END ===';
const start = html.indexOf(startMark);
const end = html.indexOf(endMark);
assert.ok(start >= 0 && end > start, 'core markers must exist in nagare.html');
vm.runInThisContext(html.slice(start, end + endMark.length), { filename: 'nagare-core.js' });
const core = globalThis.NagareCore;
assert.ok(core, 'NagareCore must be exported');

// ---------- helpers ----------
function sampleSdp(sessionId) {
  return [
    'v=0',
    'o=- ' + sessionId + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=msid-semantic: WMS stream1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:efghijklmnopqrstuvwxyz123456',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendonly',
    'a=rtpmap:96 VP8/90000',
    'a=candidate:1 1 udp 2113937151 192.168.1.10 54321 typ host generation 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    'a=sendonly',
    'a=rtpmap:111 opus/48000/2'
  ].join('\r\n') + '\r\n';
}
function samplePayload(kind, seed) {
  return {
    v: 1,
    kind: kind || 'offer',
    sdp: sampleSdp(seed || 4611686018427387904),
    ice: [
      { candidate: 'candidate:1 1 udp 2113937151 192.168.1.10 54321 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:2 1 udp 1686052607 203.0.113.5 61234 typ srflx raddr 192.168.1.10 rport 54321 generation 0', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:3 1 udp 2113937151 192.168.1.10 54322 typ host generation 0', sdpMid: '1', sdpMLineIndex: 1 }
    ],
    meta: { role: 'origin', depth: 1, name: 'テスト配信者', createdAt: 1730000000000 }
  };
}
// Deterministic PRNG for reproducible "random" payloads.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- CRC32 ----------
test('crc32 matches the standard check vector', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(core.crc32(bytes), 0xCBF43926);
  assert.equal(core.crc32Hex(bytes), 'cbf43926');
  assert.equal(core.crc32(new Uint8Array(0)), 0);
});

// ---------- base64url ----------
test('base64url round-trips arbitrary bytes', () => {
  const rnd = mulberry32(42);
  for (let len = 1; len < 300; len += 17) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rnd() * 256);
    const encoded = core.bytesToBase64Url(bytes);
    assert.ok(!/[+/=]/.test(encoded), 'must be url-safe without padding');
    assert.deepEqual(core.base64UrlToBytes(encoded), bytes);
  }
  assert.equal(core.base64UrlToBytes('not*valid'), null);
  assert.equal(core.base64UrlToBytes(''), null);
});

// ---------- signal codec ----------
test('signal codec round-trips a realistic offer payload exactly', async () => {
  const payload = samplePayload('offer');
  const code = await core.encodeSignal(payload);
  assert.match(code, /^NG1\.[A-Za-z0-9\-_]+\.[0-9a-f]{8}$/);
  const dec = await core.decodeSignal(code);
  assert.equal(dec.ok, true);
  assert.deepEqual(dec.payload, payload);
});

test('signal codec round-trips randomized payloads', async () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 25; i++) {
    const payload = samplePayload(i % 2 ? 'answer' : 'offer', Math.floor(rnd() * 1e15));
    payload.meta.name = 'user-' + Math.floor(rnd() * 1e9) + '-あ';
    payload.meta.depth = Math.floor(rnd() * 5);
    payload.ice = payload.ice.slice(0, Math.floor(rnd() * 4));
    const code = await core.encodeSignal(payload);
    const dec = await core.decodeSignal(code);
    assert.equal(dec.ok, true, 'iteration ' + i);
    assert.deepEqual(dec.payload, payload);
  }
});

test('signal codec tolerates whitespace and full invite links', async () => {
  const payload = samplePayload('offer');
  const code = await core.encodeSignal(payload);
  const withBreaks = code.slice(0, 20) + '\n  ' + code.slice(20) + '\n';
  const dec1 = await core.decodeSignal(withBreaks);
  assert.equal(dec1.ok, true);
  assert.deepEqual(dec1.payload, payload);
  const link = 'https://example.com/nagare.html#i=' + code;
  const dec2 = await core.decodeSignal(link);
  assert.equal(dec2.ok, true);
  assert.deepEqual(dec2.payload, payload);
});

test('signal codec rejects a damaged code via checksum', async () => {
  const code = await core.encodeSignal(samplePayload('offer'));
  const parts = code.split('.');
  // Flip one character in the compressed body.
  const body = parts[1];
  const flip = body[5] === 'A' ? 'B' : 'A';
  const damaged = parts[0] + '.' + body.slice(0, 5) + flip + body.slice(6) + '.' + parts[2];
  const dec = await core.decodeSignal(damaged);
  assert.equal(dec.ok, false);
  assert.equal(dec.reason, 'code-checksum');
  // Truncated code: also a checksum/format failure, never a silent success.
  const dec2 = await core.decodeSignal(code.slice(0, code.length - 12));
  assert.equal(dec2.ok, false);
});

test('signal codec rejects wrong version and garbage', async () => {
  const code = await core.encodeSignal(samplePayload('offer'));
  const v2 = 'NG2' + code.slice(3);
  const decV = await core.decodeSignal(v2);
  assert.equal(decV.ok, false);
  assert.equal(decV.reason, 'code-version');
  for (const junk of ['', 'hello', 'NG1.', 'NG1.x', 'XX1.aaaa.12345678', null, undefined, 42]) {
    const dec = await core.decodeSignal(junk);
    assert.equal(dec.ok, false, JSON.stringify(junk));
  }
});

test('signal codec rejects a well-formed code whose payload version differs', async () => {
  // Build a syntactically valid code (correct CRC) around a v:2 payload,
  // using Node zlib — the decoder must still refuse it.
  const payload = samplePayload('offer');
  payload.v = 2;
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = new Uint8Array(zlib.deflateRawSync(raw));
  const code = 'NG1.' + core.bytesToBase64Url(compressed) + '.' + core.crc32Hex(compressed);
  const dec = await core.decodeSignal(code);
  assert.equal(dec.ok, false);
  assert.equal(dec.reason, 'code-version');
});

test('signal codec rejects structurally invalid payloads', async () => {
  const bad = samplePayload('offer');
  bad.kind = 'invite';
  const raw = new TextEncoder().encode(JSON.stringify(bad));
  const compressed = new Uint8Array(zlib.deflateRawSync(raw));
  const code = 'NG1.' + core.bytesToBase64Url(compressed) + '.' + core.crc32Hex(compressed);
  const dec = await core.decodeSignal(code);
  assert.equal(dec.ok, false);
  assert.equal(dec.reason, 'payload-invalid');
});

test('validateSignalPayload checks each field', () => {
  assert.equal(core.validateSignalPayload(samplePayload('answer')).ok, true);
  const cases = [
    [p => { p.sdp = 'short'; }, 'payload-invalid'],
    [p => { p.ice = [{ nope: 1 }]; }, 'payload-invalid'],
    [p => { p.meta.role = 'server'; }, 'payload-invalid'],
    [p => { p.meta.depth = -1; }, 'payload-invalid'],
    [p => { p.meta.depth = 1.5; }, 'payload-invalid'],
    [p => { delete p.meta; }, 'payload-invalid'],
    [p => { p.v = 99; }, 'code-version']
  ];
  for (const [mutate, reason] of cases) {
    const p = samplePayload('offer');
    mutate(p);
    const r = core.validateSignalPayload(p);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
  }
});

// ---------- state machine ----------
test('session FSM follows the documented lifecycle', () => {
  const fsm = core.createFSM();
  assert.equal(fsm.state, 'idle');
  assert.equal(fsm.transition('gathering'), true);
  assert.equal(fsm.transition('awaiting-peer'), true);
  assert.equal(fsm.transition('connecting'), true);
  assert.equal(fsm.transition('connected'), true);
  assert.equal(fsm.transition('closed'), true);
  assert.equal(fsm.state, 'closed');
});

test('session FSM refuses illegal transitions and keeps state', () => {
  const fsm = core.createFSM();
  assert.equal(fsm.transition('connected'), false);
  assert.equal(fsm.state, 'idle');
  assert.equal(fsm.transition('awaiting-peer'), false);
  fsm.transition('gathering');
  assert.equal(fsm.transition('connected'), false);
  assert.equal(fsm.state, 'gathering');
  // Terminal states are sticky.
  fsm.transition('failed', 'ice-failed');
  assert.equal(fsm.transition('gathering'), false);
  assert.equal(fsm.transition('closed'), true);
  assert.equal(fsm.transition('closed'), false);
});

test('session FSM records the failure reason', () => {
  const fsm = core.createFSM();
  fsm.transition('gathering');
  fsm.transition('failed', 'connect-timeout');
  assert.equal(fsm.state, 'failed');
  assert.equal(fsm.reason, 'connect-timeout');
});

test('canTransition agrees with the transition table', () => {
  assert.equal(core.canTransition('idle', 'gathering'), true);
  assert.equal(core.canTransition('idle', 'connected'), false);
  assert.equal(core.canTransition('connected', 'failed'), true);
  assert.equal(core.canTransition('closed', 'idle'), false);
  assert.equal(core.canTransition('nonexistent', 'idle'), false);
});

// ---------- tree policy ----------
test('tree limits: children and depth', () => {
  assert.equal(core.canAddChild(0, 3), true);
  assert.equal(core.canAddChild(2, 3), true);
  assert.equal(core.canAddChild(3, 3), false);
  assert.equal(core.canAddChild(4, 3), false);
  assert.equal(core.canHostDepth(4, 4), true);
  assert.equal(core.canHostDepth(5, 4), false);
  assert.equal(core.canHostDepth(1, 1), true);
});

test('maxViewers computes tree capacity', () => {
  assert.equal(core.maxViewers(3, 4), 120); // 3+9+27+81
  assert.equal(core.maxViewers(3, 1), 3);
  assert.equal(core.maxViewers(2, 3), 14);  // 2+4+8
  assert.equal(core.maxViewers(1, 5), 5);
  assert.equal(core.maxViewers(0, 4), 0);
  assert.equal(core.maxViewers(3, 0), 0);
});

test('estimateUplinkKbps includes protocol overhead', () => {
  assert.equal(core.estimateUplinkKbps(2000, 3), 6900);
  assert.equal(core.estimateUplinkKbps(4500, 1), 5175);
  assert.equal(core.estimateUplinkKbps(900, 0), 0);
});

test('computeSubtree aggregates child reports and ignores junk', () => {
  assert.equal(core.computeSubtree(0, []), 0);
  assert.equal(core.computeSubtree(2, [3, 4]), 9);
  assert.equal(core.computeSubtree(1, [0, -5, 2.5, 'x', null]), 1);
  assert.equal(core.computeSubtree(3, [10, 20]), 33);
});

// ---------- data channel protocol ----------
test('protocol messages round-trip through parseMessage', () => {
  const chat = core.msgChat('m1', 'Alice', 'こんにちは', 1730000000000);
  assert.deepEqual(core.parseMessage(JSON.stringify(chat)), chat);
  assert.deepEqual(core.parseMessage(JSON.stringify(core.msgHello('Bob', 2))), { type: 'hello', name: 'Bob', depth: 2 });
  assert.deepEqual(core.parseMessage(JSON.stringify(core.msgState(7))), { type: 'state', subtree: 7 });
  assert.deepEqual(core.parseMessage(JSON.stringify(core.msgAudience(42))), { type: 'audience', total: 42 });
  assert.deepEqual(core.parseMessage(JSON.stringify(core.msgBye('peer-left'))), { type: 'bye', reason: 'peer-left' });
});

test('parseMessage rejects malformed input instead of throwing', () => {
  assert.equal(core.parseMessage('not json'), null);
  assert.equal(core.parseMessage(''), null);
  assert.equal(core.parseMessage('null'), null);
  assert.equal(core.parseMessage('{"type":"unknown"}'), null);
  assert.equal(core.parseMessage('{"type":"chat","id":"","from":"a","text":"x","ts":1}'), null);
  assert.equal(core.parseMessage('{"type":"chat","id":"m","from":"a","text":"x","ts":"1"}'), null);
  const longText = 'x'.repeat(core.MAX_CHAT_LEN + 1);
  assert.equal(core.parseMessage(JSON.stringify({ type: 'chat', id: 'm', from: 'a', text: longText, ts: 1 })), null);
  assert.equal(core.parseMessage('{"type":"state","subtree":-1}'), null);
  assert.equal(core.parseMessage('{"type":"state","subtree":1.5}'), null);
  assert.equal(core.parseMessage('{"type":"audience","total":"3"}'), null);
  assert.equal(core.parseMessage('{"type":"hello","name":"a","depth":-2}'), null);
});

// ---------- quality presets ----------
test('quality presets are internally consistent', () => {
  for (const [name, q] of Object.entries(core.QUALITY)) {
    assert.ok(q.videoKbps >= 0, name);
    if (name !== 'audio') {
      assert.ok(q.width > 0 && q.height > 0 && q.frameRate > 0, name);
    }
  }
  assert.ok(core.QUALITY['720p'].videoKbps < core.QUALITY['1080p'].videoKbps);
});
