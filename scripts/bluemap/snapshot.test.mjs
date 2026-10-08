import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { acquireSnapshot, watchOffline } from './snapshot.mjs';

const LEVEL = gzipSync(Buffer.from([10, 0, 0, 0]));
const REGION = Buffer.alloc(8192);
const ENV = { EXAROTON_API_TOKEN: 'test-private-token', EXAROTON_SERVER_ID: 'test-server' };

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bluemap-snapshot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function previousWorld(root) {
  await mkdir(path.join(root, 'state', 'world'), { recursive: true });
  await writeFile(path.join(root, 'state', 'world', 'previous'), 'last successful snapshot');
}

function fakeMonitor() {
  let failure;
  let onFailure;
  let closed = false;
  return {
    factory: async (options) => {
      onFailure = options.onFailure;
      return {
        assertOffline() { if (failure) throw failure; },
        close() { closed = true; },
      };
    },
    interrupt() { failure = new Error('test status change'); onFailure(failure); },
    get closed() { return closed; },
  };
}

function fakeAPI({ readable = true, status = 0, binaryFailure = false, modify, transient = false, regionData = REGION, regionPath = 'region', binaryType = 'application/octet-stream' } = {}) {
  const downloads = [];
  const requests = [];
  let transientFailed = false;
  const files = {
    'world/level.dat': LEVEL,
    [`world/${regionPath}/r.0.0.mca`]: regionData,
    [`world/${regionPath}/r.1.0.mca`]: REGION,
    [`world/${regionPath}/c.0.0.mcc`]: Buffer.from([1, 2, 3]),
  };
  return {
    downloads, requests,
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${ENV.EXAROTON_API_TOKEN}`);
      assert.equal(options.redirect, 'error');
      const route = new URL(url).pathname;
      requests.push(route);
      if (route === '/v1/servers/test-server') {
        return Response.json({ success: true, data: { status, software: { version: '1.21.11' } } });
      }
      const info = '/v1/servers/test-server/files/info/';
      const data = '/v1/servers/test-server/files/data/';
      if (route.startsWith(info)) {
        const name = route.slice(info.length, -1);
        if (name === `world/${regionPath}`) {
          return Response.json({ success: true, data: {
            isDirectory: true,
            children: Object.keys(files).filter((entry) => entry.startsWith(`world/${regionPath}/`)).map((entry) => ({ name: path.posix.basename(entry) })),
          } });
        }
        if (!files[name]) return new Response(null, { status: 404 });
        return Response.json({ success: true, data: { isDirectory: false, isReadable: readable, size: files[name].length } });
      }
      assert.ok(route.startsWith(data), `Unexpected request: ${route}`);
      const name = route.slice(data.length, -1);
      downloads.push(name);
      modify?.(name);
      if (binaryFailure) return Response.json({ success: false, error: 'account cannot read binary files' });
      if (transient && !transientFailed && name.endsWith('level.dat')) {
        transientFailed = true;
        return new Response(null, { status: 503 });
      }
      return new Response(files[name], { headers: { 'content-type': binaryType } });
    },
  };
}

test('missing credentials skips without creating state', async (t) => {
  const root = await temporary(t);
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: {} });
  assert.equal(result.status, 'skipped');
  assert.deepEqual(await readdir(root), []);
});

test('supplied offline folder is copied into a complete private snapshot', async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, 'source', 'region'), { recursive: true });
  await writeFile(path.join(root, 'source', 'level.dat'), LEVEL);
  await writeFile(path.join(root, 'source', 'region', 'r.0.0.mca'), REGION);
  await writeFile(path.join(root, 'source', 'private-player-data'), 'not required for rendering');
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { BLUEMAP_WORLD_SOURCE: path.join(root, 'source') } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(await readFile(path.join(result.worldPath, 'level.dat')), LEVEL);
  assert.deepEqual(await readdir(result.worldPath), ['level.dat', 'region']);
  assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
});

test('invalid supplied region never replaces a successful snapshot', async (t) => {
  const root = await temporary(t);
  await previousWorld(root);
  await mkdir(path.join(root, 'source', 'region'), { recursive: true });
  await writeFile(path.join(root, 'source', 'level.dat'), LEVEL);
  await writeFile(path.join(root, 'source', 'region', 'r.0.0.mca'), Buffer.alloc(20));
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { BLUEMAP_WORLD_SOURCE: path.join(root, 'source') } });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /region file/);
  assert.equal(await readFile(path.join(root, 'state', 'world', 'previous'), 'utf8'), 'last successful snapshot');
  assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
});

test('online server is skipped before reading world files', async (t) => {
  const root = await temporary(t);
  const api = fakeAPI({ status: 1 });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /not offline/);
  assert.equal(api.requests.length, 1);
  assert.equal(monitor.closed, true);
});

test('file metadata restriction stops before binary downloads', async (t) => {
  const root = await temporary(t);
  const api = fakeAPI({ readable: false });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /BLUEMAP_WORLD_SOURCE/);
  assert.deepEqual(api.downloads, []);
});

test('binary probe restriction preserves the prior snapshot and stops the remaining downloads', async (t) => {
  const root = await temporary(t);
  await previousWorld(root);
  const api = fakeAPI({ binaryFailure: true });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'skipped');
  assert.deepEqual(api.downloads, ['world/level.dat']);
  assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
  assert.equal(await readFile(path.join(root, 'state', 'world', 'previous'), 'utf8'), 'last successful snapshot');
  assert.ok(!result.reason.includes(ENV.EXAROTON_API_TOKEN));
});

test('binary probes precede remaining files, external chunks are included, and equal-size regions refresh', async (t) => {
  const root = await temporary(t);
  const first = fakeAPI();
  let monitor = fakeMonitor();
  const options = { stateDir: path.join(root, 'state'), env: ENV, fetchImpl: first.fetch, monitorFactory: monitor.factory };
  const result = await acquireSnapshot(options);
  assert.equal(result.status, 'ready');
  assert.equal(result.minecraftVersion, '1.21.11');
  assert.deepEqual(first.downloads.slice(0, 2), ['world/level.dat', 'world/region/r.0.0.mca']);
  assert.equal(first.downloads.length, 4);
  assert.deepEqual(await readFile(path.join(result.worldPath, 'region', 'c.0.0.mcc')), Buffer.from([1, 2, 3]));
  const changed = Buffer.from(REGION);
  changed[4096] = 1;
  const second = fakeAPI({ regionData: changed });
  monitor = fakeMonitor();
  const next = await acquireSnapshot({ ...options, fetchImpl: second.fetch, monitorFactory: monitor.factory });
  assert.equal(next.status, 'ready');
  assert.deepEqual(await readFile(path.join(next.worldPath, 'region', 'r.0.0.mca')), changed);
  assert.equal(second.downloads.length, 4);
  assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
});

test('status stream interruption discards a partially downloaded snapshot', async (t) => {
  const root = await temporary(t);
  await previousWorld(root);
  const monitor = fakeMonitor();
  const api = fakeAPI({ modify(name) { if (name.endsWith('r.0.0.mca')) monitor.interrupt(); } });
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'skipped');
  assert.equal(monitor.closed, true);
  assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
  assert.equal(await readFile(path.join(root, 'state', 'world', 'previous'), 'utf8'), 'last successful snapshot');
});

test('temporary API errors retry and yield a complete snapshot', async (t) => {
  const root = await temporary(t);
  const api = fakeAPI({ transient: true });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'ready');
  assert.equal(api.downloads.filter((name) => name.endsWith('level.dat')).length, 2);
});

test('valid world bytes with exaroton text/html headers are accepted', async (t) => {
  const root = await temporary(t);
  const api = fakeAPI({ binaryType: 'text/html; charset=UTF-8' });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'ready');
  assert.deepEqual(await readFile(path.join(result.worldPath, 'level.dat')), LEVEL);
  assert.deepEqual(await readFile(path.join(result.worldPath, 'region', 'r.0.0.mca')), REGION);
});

test('modern Overworld paths are discovered after the classic directory returns 404', async (t) => {
  const root = await temporary(t);
  const regionPath = 'dimensions/minecraft/overworld/region';
  const api = fakeAPI({ regionPath, binaryType: 'text/html; charset=UTF-8' });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: ENV, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'ready');
  assert.ok(api.requests.includes('/v1/servers/test-server/files/info/world/region/'));
  assert.ok(api.requests.includes(`/v1/servers/test-server/files/info/world/${regionPath}/`));
  assert.deepEqual(api.downloads.slice(0, 2), ['world/level.dat', `world/${regionPath}/r.0.0.mca`]);
  assert.deepEqual(await readdir(result.worldPath), ['level.dat', 'region']);
  assert.deepEqual(await readFile(path.join(result.worldPath, 'region', 'r.0.0.mca')), REGION);
});

test('a configured region path selects a custom Overworld directory', async (t) => {
  const root = await temporary(t);
  const api = fakeAPI({ regionPath: 'terrain' });
  const monitor = fakeMonitor();
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { ...ENV, EXAROTON_REGION_PATH: 'terrain' }, fetchImpl: api.fetch, monitorFactory: monitor.factory });
  assert.equal(result.status, 'ready');
  assert.ok(!api.requests.includes('/v1/servers/test-server/files/info/world/region/'));
  assert.deepEqual(api.downloads.slice(0, 2), ['world/level.dat', 'world/terrain/r.0.0.mca']);
});

test('a supplied modern world folder is normalized to the renderer snapshot layout', async (t) => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const region = path.join(source, 'dimensions', 'minecraft', 'overworld', 'region');
  await mkdir(region, { recursive: true });
  await mkdir(path.join(source, 'region'));
  await writeFile(path.join(source, 'level.dat'), LEVEL);
  await writeFile(path.join(region, 'r.0.0.mca'), REGION);
  const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { BLUEMAP_WORLD_SOURCE: source } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(await readdir(result.worldPath), ['level.dat', 'region']);
  assert.deepEqual(await readFile(path.join(result.worldPath, 'region', 'r.0.0.mca')), REGION);
});

function frame(payload, opcode = 1, fin = true) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = bytes.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, bytes.length]) : Buffer.alloc(4);
  if (bytes.length >= 126) { header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
  return Buffer.concat([header, bytes]);
}

function websocketFixture(head = frame({ type: 'ready', data: ENV.EXAROTON_SERVER_ID }), alterResponse = (value) => value) {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.write = (bytes) => socket.writes.push(bytes);
  socket.destroy = () => {};
  socket.setTimeout = () => {};
  const requestImpl = (url, options) => {
    assert.equal(url, `https://api.exaroton.com/v1/servers/${ENV.EXAROTON_SERVER_ID}/websocket`);
    assert.equal(options.headers.Authorization, `Bearer ${ENV.EXAROTON_API_TOKEN}`);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      const accept = createHash('sha1').update(`${options.headers['Sec-WebSocket-Key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      request.emit('upgrade', alterResponse({ statusCode: 101, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-accept': accept } }), socket, head);
    };
    return request;
  };
  return { socket, requestImpl };
}

test('status monitor remembers rapid offline -> online -> offline transitions', async () => {
  const fixture = websocketFixture();
  let failures = 0;
  const monitor = await watchOffline({ token: ENV.EXAROTON_API_TOKEN, serverId: ENV.EXAROTON_SERVER_ID, requestImpl: fixture.requestImpl, onFailure() { failures += 1; } });
  monitor.assertOffline();
  fixture.socket.emit('data', Buffer.concat([
    frame({ stream: 'status', type: 'status', data: { status: 1 } }),
    frame({ stream: 'status', type: 'status', data: { status: 0 } }),
  ]));
  assert.throws(() => monitor.assertOffline(), /changed status/);
  assert.equal(failures, 1);
  monitor.close();
});

test('status monitor accepts fragmented text and split network frames and masks pong responses', async () => {
  const ready = Buffer.from(JSON.stringify({ type: 'ready', data: ENV.EXAROTON_SERVER_ID }));
  const fixture = websocketFixture(Buffer.concat([frame(ready.subarray(0, 10), 1, false), frame(ready.subarray(10), 0)]));
  const monitor = await watchOffline({ token: ENV.EXAROTON_API_TOKEN, serverId: ENV.EXAROTON_SERVER_ID, requestImpl: fixture.requestImpl });
  const status = frame({ stream: 'status', type: 'status', data: { status: 0 } });
  fixture.socket.emit('data', status.subarray(0, 3));
  fixture.socket.emit('data', status.subarray(3));
  fixture.socket.emit('data', frame(Buffer.from('ping'), 9));
  monitor.assertOffline();
  assert.equal(fixture.socket.writes.length, 1);
  const pong = fixture.socket.writes[0];
  assert.equal(pong[0], 0x8a);
  assert.equal(pong[1], 0x84);
  const unmasked = Buffer.from(pong.subarray(6));
  for (let index = 0; index < unmasked.length; index += 1) unmasked[index] ^= pong[2 + index % 4];
  assert.equal(unmasked.toString(), 'ping');
  monitor.close();
});

test('status monitor fails closed on disconnect and unsupported protocol data', async () => {
  for (const bad of ['close', 'masked']) {
    const fixture = websocketFixture();
    const monitor = await watchOffline({ token: ENV.EXAROTON_API_TOKEN, serverId: ENV.EXAROTON_SERVER_ID, requestImpl: fixture.requestImpl });
    if (bad === 'close') fixture.socket.emit('close');
    else fixture.socket.emit('data', Buffer.from([0x81, 0x80]));
    assert.throws(() => monitor.assertOffline());
    monitor.close();
  }
});

test('status monitor rejects invalid HTTP upgrades and a missing ready message', async () => {
  for (const altered of [
    (response) => ({ ...response, statusCode: 200 }),
    (response) => ({ ...response, headers: { ...response.headers, 'sec-websocket-accept': 'invalid' } }),
    (response) => ({ ...response, headers: { ...response.headers, connection: 'close' } }),
  ]) {
    const fixture = websocketFixture(undefined, altered);
    await assert.rejects(watchOffline({ token: ENV.EXAROTON_API_TOKEN, serverId: ENV.EXAROTON_SERVER_ID, requestImpl: fixture.requestImpl }), /handshake/);
  }
  const fixture = websocketFixture(Buffer.alloc(0));
  await assert.rejects(watchOffline({ token: ENV.EXAROTON_API_TOKEN, serverId: ENV.EXAROTON_SERVER_ID, requestImpl: fixture.requestImpl, timeoutMs: 5 }), /Timed out/);
});

const python = process.env.PYTHON || 'python3';
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;

function writeZIP(file, entries) {
  const program = [
    'import base64,json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:',
    ' for entry in json.loads(sys.argv[2]):',
    '  info = zipfile.ZipInfo(entry["name"])',
    '  if "mode" in entry: info.create_system = 3; info.external_attr = entry["mode"] << 16',
    '  archive.writestr(info, base64.b64decode(entry["data"]))',
  ].join('\n');
  const result = spawnSync(python, ['-c', program, file, JSON.stringify(entries)], { stdio: 'ignore', windowsHide: true });
  assert.equal(result.status, 0, 'Could not create the ZIP test fixture.');
}

test('ZIP fallback locates wrapped classic and modern offline worlds', { skip: hasPython ? false : 'Python 3 is unavailable; ZIP fallback needs Python 3.' }, async (t) => {
  const root = await temporary(t);
  const zip = path.join(root, 'world.zip');
  for (const region of ['region', 'dimensions/minecraft/overworld/region']) {
    writeZIP(zip, [
      { name: 'my-world/level.dat', data: LEVEL.toString('base64') },
      { name: `my-world/${region}/r.0.0.mca`, data: REGION.toString('base64') },
    ]);
    const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { BLUEMAP_WORLD_SOURCE: zip, PYTHON: python } });
    assert.equal(result.status, 'ready', region);
    assert.deepEqual(await readFile(path.join(result.worldPath, 'level.dat')), LEVEL);
    assert.deepEqual(await readFile(path.join(result.worldPath, 'region', 'r.0.0.mca')), REGION);
    assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
  }
});

test('ZIP fallback rejects traversal, links, duplicates, and oversized contents without replacing state', { skip: hasPython ? false : 'Python 3 is unavailable; ZIP fallback needs Python 3.' }, async (t) => {
  const root = await temporary(t);
  await previousWorld(root);
  const valid = [
    { name: 'world/level.dat', data: LEVEL.toString('base64') },
    { name: 'world/region/r.0.0.mca', data: REGION.toString('base64') },
  ];
  for (const [name, extra, limit] of [
    ['traversal', { name: '../outside', data: Buffer.from('unsafe').toString('base64') }],
    ['link', { name: 'world/link', data: Buffer.from('../outside').toString('base64'), mode: 0o120777 }],
    ['duplicate', valid[0]],
    ['oversized', undefined, String(REGION.length)],
  ]) {
    const zip = path.join(root, `${name}.zip`);
    writeZIP(zip, extra ? [...valid, extra] : valid);
    const result = await acquireSnapshot({ stateDir: path.join(root, 'state'), env: { BLUEMAP_WORLD_SOURCE: zip, PYTHON: python, BLUEMAP_WORLD_MAX_BYTES: limit } });
    assert.equal(result.status, 'skipped', name);
    assert.match(result.reason, /ZIP/, name);
    assert.equal(await readFile(path.join(root, 'state', 'world', 'previous'), 'utf8'), 'last successful snapshot');
    assert.deepEqual(await readdir(path.join(root, 'state')), ['world']);
  }
  assert.ok(!(await readdir(root)).includes('outside'));
});
