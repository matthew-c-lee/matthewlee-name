import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const API = 'https://api.exaroton.com/v1';
const REGION_FILE = /^r\.-?\d+\.-?\d+\.mca$/;
const EXTERNAL_CHUNK = /^c\.-?\d+\.-?\d+\.mcc$/;
const OVERWORLD_REGIONS = ['region', 'dimensions/minecraft/overworld/region'];
const DEFAULT_MAX_BYTES = 8 * 1024 ** 3;

class SnapshotUnavailable extends Error {}

function positiveNumber(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new SnapshotUnavailable('Snapshot limits must be positive integers.');
  }
  return number;
}

function remotePath(value, setting = 'EXAROTON_WORLD_PATH') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new SnapshotUnavailable(`${setting} must be a relative server directory.`);
  }
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new SnapshotUnavailable(`${setting} must be a relative server directory.`);
  }
  return parts.join('/');
}

function encodedPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function fallbackReason(error) {
  return error instanceof SnapshotUnavailable
    ? error.message
    : 'Snapshot acquisition failed; the previous successful map is retained.';
}

async function withRetries(operation, { signal, attempts = 3 }) {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SnapshotUnavailable || signal?.aborted || attempt + 1 >= attempts) throw error;
      await delay(500 * 2 ** attempt, undefined, { signal });
    }
  }
}

function checkResponse(response) {
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) {
      throw new SnapshotUnavailable('exaroton denied access to the server or world files. Supply BLUEMAP_WORLD_SOURCE using an offline world export.');
    }
    if (response.status >= 500 || response.status === 429) throw new Error('Temporary exaroton API failure.');
    throw new SnapshotUnavailable(`exaroton returned HTTP ${response.status}; the previous map is retained.`);
  }
}

function client({ token, serverId, fetchImpl, timeoutMs, signal }) {
  const server = `${API}/servers/${encodeURIComponent(serverId)}`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async json(suffix, { allowMissing = false } = {}) {
      return withRetries(async () => {
        const response = await fetchImpl(`${server}${suffix}`, {
          headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (allowMissing && response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        checkResponse(response);
        const body = await response.json();
        if (body.success !== true || !body.data) {
          throw new SnapshotUnavailable('exaroton could not read the requested world files. Supply BLUEMAP_WORLD_SOURCE using an offline world export.');
        }
        return body.data;
      }, { signal });
    },
    async download(remote, destination, expectedSize, maxBytes) {
      await mkdir(path.dirname(destination), { recursive: true });
      await withRetries(async () => {
        const temporary = `${destination}.partial`;
        try {
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
          const response = await fetchImpl(`${server}/files/data/${encodedPath(remote)}/`, {
            headers, redirect: 'error', signal: requestSignal,
          });
          checkResponse(response);
          // exaroton can label valid binary downloads as text/html. Validate the
          // downloaded file bytes instead of trusting that response header.
          if (!response.body) {
            throw new SnapshotUnavailable('exaroton did not return binary world data. Supply BLUEMAP_WORLD_SOURCE using an offline world export.');
          }
          const length = response.headers.get('content-length');
          if (length && Number(length) > maxBytes) throw new SnapshotUnavailable('The world exceeds BLUEMAP_WORLD_MAX_BYTES.');
          let bytes = 0;
          const source = Readable.from((async function* () {
            for await (const chunk of Readable.fromWeb(response.body)) {
              bytes += chunk.length;
              if (bytes > maxBytes) throw new SnapshotUnavailable('The world exceeds BLUEMAP_WORLD_MAX_BYTES.');
              yield chunk;
            }
          })());
          await pipeline(source, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: requestSignal });
          if ((!bytes && expectedSize !== 0) || (Number.isSafeInteger(expectedSize) && bytes !== expectedSize)) {
            throw new Error('Incomplete world file download.');
          }
          await validateWorldFile(temporary, remote);
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }, { signal });
      return (await stat(destination)).size;
    },
  };
}

// The documented REST server object has no status-change timestamp. Keep the
// read-only status WebSocket open so even offline -> online -> offline invalidates
// the snapshot. Loss of this connection also discards the in-progress snapshot.
export async function watchOffline({ token, serverId, onFailure, timeoutMs = 30000, requestImpl = https.request }) {
  const key = randomBytes(16).toString('base64');
  let socket;
  let request;
  let failure;
  let closed = false;
  let pending = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let ready = false;
  let resolveReady;
  let rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (message) => {
    if (closed || failure) return;
    failure = new SnapshotUnavailable(message);
    rejectReady(failure);
    onFailure?.(failure);
    socket?.destroy();
    request?.destroy();
  };
  const sendControl = (opcode, payload = Buffer.alloc(0)) => {
    const mask = randomBytes(4);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ mask[i % 4];
    socket.write(frame);
  };
  const message = (payload) => {
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch {
      fail('Invalid exaroton status stream; the incomplete snapshot was discarded.');
      return;
    }
    if (data.type === 'ready') {
      if (data.data !== serverId) return fail('exaroton status stream server mismatch.');
      ready = true;
      resolveReady();
    }
    if (data.stream === 'status' && (data.type !== 'status' || data.data?.status !== 0)) {
      fail('The exaroton server changed status; the incomplete snapshot was discarded.');
    }
    if (data.type === 'connected') fail('The exaroton server is running; the incomplete snapshot was discarded.');
    if (data.type === 'error') fail('The exaroton status stream reported an error; the incomplete snapshot was discarded.');
  };
  const receive = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2 && !failure) {
      const fin = Boolean(pending[0] & 0x80);
      const opcode = pending[0] & 0x0f;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if ((pending[0] & 0x70) || (pending[1] & 0x80)) return fail('Unsupported exaroton status stream framing.');
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        const largeLength = pending.readBigUInt64BE(2);
        if (largeLength > 1024n * 1024n) return fail('exaroton status message exceeds the allowed size.');
        length = Number(largeLength);
        offset = 10;
      }
      if (length > 1024 * 1024 || (opcode >= 8 && (!fin || length > 125))) return fail('Invalid exaroton status stream framing.');
      if (pending.length < offset + length) return;
      const payload = pending.subarray(offset, offset + length);
      pending = pending.subarray(offset + length);
      if (opcode === 8) return fail('The exaroton status connection closed; the incomplete snapshot was discarded.');
      if (opcode === 9) { sendControl(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && fragments.length === 0) {
        if (fin) message(payload);
        else { fragments = [payload]; fragmentBytes = payload.length; }
      } else if (opcode === 0 && fragments.length) {
        fragmentBytes += payload.length;
        if (fragmentBytes > 1024 * 1024) return fail('exaroton status message exceeds the allowed size.');
        fragments.push(payload);
        if (fin) { message(Buffer.concat(fragments)); fragments = []; fragmentBytes = 0; }
      } else return fail('Unexpected exaroton status stream frame.');
    }
  };
  const timer = setTimeout(() => fail('Timed out opening the exaroton status stream; the previous map is retained.'), timeoutMs);
  try {
    request = requestImpl(`${API}/servers/${encodeURIComponent(serverId)}/websocket`, {
      headers: {
        Authorization: `Bearer ${token}`, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    request.on('upgrade', (response, connection, head) => {
      socket = connection;
      const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected
        || response.headers.upgrade?.toLowerCase() !== 'websocket'
        || !response.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade')
        || response.headers['sec-websocket-extensions']) return fail('exaroton rejected the status stream handshake.');
      socket.on('data', receive);
      socket.on('error', () => fail('The exaroton status connection failed; the incomplete snapshot was discarded.'));
      socket.on('close', () => fail('The exaroton status connection closed; the incomplete snapshot was discarded.'));
      socket.setTimeout(120000, () => fail('The exaroton status connection timed out; the incomplete snapshot was discarded.'));
      if (head.length) receive(head);
    });
    request.on('response', (response) => {
      response.resume();
      fail('exaroton denied the status stream; the previous map is retained.');
    });
    request.on('error', () => fail('Could not open the exaroton status stream; the previous map is retained.'));
    request.end();
    await started;
  } catch (error) {
    closed = true;
    socket?.destroy();
    request?.destroy();
    throw error;
  } finally { clearTimeout(timer); }
  return {
    assertOffline() {
      if (failure) throw failure;
      if (!ready || closed) throw new SnapshotUnavailable('The exaroton status stream is unavailable.');
    },
    close() { closed = true; socket?.destroy(); request?.destroy(); },
  };
}

async function validateWorldFile(file, name) {
  const info = await stat(file);
  if (!info.size) {
    // BlueMap's MCARegion treats zero-byte .mca files as regions with no chunks.
    // Keep them in the snapshot so incremental renders can remove old terrain.
    if (REGION_FILE.test(path.posix.basename(name))) return;
    throw new SnapshotUnavailable(`World file is empty: ${path.posix.basename(name)}.`);
  }
  if (path.posix.basename(name) === 'level.dat') {
    if (info.size > 32 * 1024 ** 2) throw new SnapshotUnavailable('level.dat exceeds the allowed size.');
    const handle = await open(file, 'r');
    try {
      const bytes = await handle.readFile();
      const nbt = bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 ** 2 }) : bytes;
      if (nbt.length < 4 || nbt[0] !== 10) throw new SnapshotUnavailable('level.dat is not a Java Edition NBT world file.');
    } finally { await handle.close(); }
  } else if (REGION_FILE.test(path.posix.basename(name))) {
    if (info.size < 8192 || info.size % 4096 !== 0) throw new SnapshotUnavailable('A region file is incomplete or invalid.');
    const handle = await open(file, 'r');
    try {
      const header = Buffer.alloc(4096);
      await handle.read(header, 0, header.length, 0);
      for (let index = 0; index < 4096; index += 4) {
        const sector = header.readUIntBE(index, 3);
        const count = header[index + 3];
        if ((sector === 0) !== (count === 0) || (sector && (sector < 2 || (sector + count) * 4096 > info.size))) {
          throw new SnapshotUnavailable('A region file contains invalid chunk offsets.');
        }
      }
    } finally { await handle.close(); }
  }
}

async function locateWorld(root) {
  const candidates = [];
  const walk = async (directory, depth) => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'level.dat' && entry.isFile())) candidates.push(directory);
    if (depth < 2) {
      for (const entry of entries) if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  if (candidates.length !== 1) throw new SnapshotUnavailable('The supplied source must contain exactly one Java Edition world with level.dat.');
  return candidates[0];
}

async function copySuppliedWorld(source, staging, maxBytes, env, check) {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new SnapshotUnavailable('World sources must not be symbolic links.');
  let root = source;
  let extracted;
  try {
    if (sourceInfo.isFile()) {
      if (path.extname(source).toLowerCase() !== '.zip') throw new SnapshotUnavailable('BLUEMAP_WORLD_SOURCE must be a world folder or ZIP archive.');
      extracted = await mkdtemp(path.join(path.dirname(staging), 'archive-'));
      await new Promise((resolve, reject) => {
        const child = spawn(env.PYTHON || 'python3', [fileURLToPath(new URL('./extract-world.py', import.meta.url)), source, extracted, String(maxBytes)], {
          stdio: 'ignore', windowsHide: true, timeout: 120000,
          env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
        });
        child.on('error', () => reject(new SnapshotUnavailable('Could not extract the ZIP. Install Python 3 or supply an unpacked world folder.')));
        child.on('exit', (code) => code === 0 ? resolve() : reject(new SnapshotUnavailable('The supplied ZIP is invalid, unsafe, or exceeds BLUEMAP_WORLD_MAX_BYTES.')));
      });
      root = extracted;
    } else if (!sourceInfo.isDirectory()) throw new SnapshotUnavailable('BLUEMAP_WORLD_SOURCE must be a world folder or ZIP archive.');
    root = await locateWorld(root);
    let regionDirectory;
    let names;
    const candidates = env.EXAROTON_REGION_PATH?.trim()
      ? [remotePath(env.EXAROTON_REGION_PATH.trim(), 'EXAROTON_REGION_PATH')] : OVERWORLD_REGIONS;
    for (const candidate of candidates) {
      const directory = path.join(root, candidate);
      const regionInfo = await lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!regionInfo) continue;
      if (!regionInfo.isDirectory() || regionInfo.isSymbolicLink()) throw new SnapshotUnavailable('The world region directory must not be a symbolic link.');
      const entries = (await readdir(directory)).filter((name) => REGION_FILE.test(name) || EXTERNAL_CHUNK.test(name)).sort();
      if (entries.some((name) => REGION_FILE.test(name))) { regionDirectory = candidate; names = entries; break; }
    }
    if (!regionDirectory) throw new SnapshotUnavailable('The supplied world has no Overworld region .mca files in the classic or modern world layout.');
    let bytes = 0;
    const files = [{ from: 'level.dat', to: 'level.dat' }, ...names.map((name) => ({ from: `${regionDirectory}/${name}`, to: `region/${name}` }))];
    for (const { from, to } of files) {
      await check();
      const file = path.join(root, from);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotUnavailable('World files must be regular files without symbolic links.');
      bytes += info.size;
      if (bytes > maxBytes) throw new SnapshotUnavailable('The world exceeds BLUEMAP_WORLD_MAX_BYTES.');
      await mkdir(path.dirname(path.join(staging, to)), { recursive: true });
      await copyFile(file, path.join(staging, to));
      await validateWorldFile(path.join(staging, to), to);
    }
  } finally { if (extracted) await rm(extracted, { recursive: true, force: true }); }
}

async function replaceWorld(staging, destination) {
  const previous = `${destination}.previous-${randomBytes(8).toString('hex')}`;
  let backedUp = false;
  try {
    await rename(destination, previous).then(() => { backedUp = true; }, (error) => { if (error.code !== 'ENOENT') throw error; });
    await rename(staging, destination);
  } catch (error) {
    if (backedUp) await rename(previous, destination);
    throw error;
  }
  if (backedUp) await rm(previous, { recursive: true, force: true });
}

export async function acquireSnapshot({ stateDir = '.bluemap', env = process.env, fetchImpl = fetch, monitorFactory = watchOffline } = {}) {
  const token = env.EXAROTON_API_TOKEN?.trim();
  const serverId = env.EXAROTON_SERVER_ID?.trim();
  const source = env.BLUEMAP_WORLD_SOURCE?.trim();
  if (!source && (!token || !serverId)) return { status: 'skipped', reason: 'No exaroton credentials or supplied world; the previous map is retained.' };
  const controller = new AbortController();
  let monitor;
  let staging;
  let server;
  let interrupted;
  try {
    const timeoutMs = positiveNumber(env.EXAROTON_TIMEOUT_MS, 120000);
    const maxBytes = positiveNumber(env.BLUEMAP_WORLD_MAX_BYTES, DEFAULT_MAX_BYTES);
    const world = remotePath(env.EXAROTON_WORLD_PATH || 'world');
    const api = token && serverId ? client({ token, serverId, fetchImpl, timeoutMs, signal: controller.signal }) : null;
    if (api) {
      // Establish observation before reading the initial REST status.
      monitor = await monitorFactory({ token, serverId, timeoutMs: Math.min(timeoutMs, 30000), onFailure(error) {
        interrupted = error;
        controller.abort(error);
      } });
      monitor.assertOffline();
      server = await api.json('');
      if (server.status !== 0) throw new SnapshotUnavailable('The exaroton server is not offline; map refresh skipped.');
    }
    const check = async () => {
      monitor?.assertOffline();
      controller.signal.throwIfAborted();
      if (api && (await api.json('')).status !== 0) {
        throw new SnapshotUnavailable('The exaroton server changed status; the incomplete snapshot was discarded.');
      }
      monitor?.assertOffline();
    };
    const directory = path.resolve(stateDir);
    await mkdir(directory, { recursive: true });
    staging = await mkdtemp(path.join(directory, 'snapshot-'));
    if (source) {
      await copySuppliedWorld(path.resolve(source), staging, maxBytes, env, check);
    } else {
      await check();
      const level = await api.json(`/files/info/${encodedPath(`${world}/level.dat`)}/`);
      if (level.isDirectory || level.isReadable !== true) {
        throw new SnapshotUnavailable('exaroton does not expose readable Java world files. Supply BLUEMAP_WORLD_SOURCE using an offline world export.');
      }
      let regionDirectory;
      let names;
      const candidates = env.EXAROTON_REGION_PATH?.trim()
        ? [remotePath(env.EXAROTON_REGION_PATH.trim(), 'EXAROTON_REGION_PATH')] : OVERWORLD_REGIONS;
      for (const candidate of candidates) {
        await check();
        const directory = `${world}/${candidate}`;
        const region = await api.json(`/files/info/${encodedPath(directory)}/`, { allowMissing: true });
        if (!region?.isDirectory || !Array.isArray(region.children)) continue;
        const entries = region.children.map((child) => child.name || path.posix.basename(child.path || '')).filter((name) => REGION_FILE.test(name) || EXTERNAL_CHUNK.test(name)).sort();
        if (entries.some((name) => REGION_FILE.test(name))) { regionDirectory = directory; names = entries; break; }
      }
      if (!regionDirectory) throw new SnapshotUnavailable('No Overworld region .mca files were available in the classic or modern world layout. Check EXAROTON_WORLD_PATH or set EXAROTON_REGION_PATH.');
      let firstName;
      let first;
      for (const name of names.filter((entry) => REGION_FILE.test(entry))) {
        await check();
        const info = await api.json(`/files/info/${encodedPath(`${regionDirectory}/${name}`)}/`);
        if (info.isDirectory || info.isReadable !== true) throw new SnapshotUnavailable('exaroton does not allow binary region downloads for this account. Supply BLUEMAP_WORLD_SOURCE using an offline world export.');
        if (info.size === 0) continue;
        firstName = name;
        first = info;
        break;
      }
      if (!firstName) throw new SnapshotUnavailable('The Overworld has no non-empty region files to render; the previous map is retained.');
      // Actually download both binary probes before collecting the rest. Metadata
      // alone does not establish that this account can download a world.
      let bytes = await api.download(`${world}/level.dat`, path.join(staging, 'level.dat'), level.size, maxBytes);
      await check();
      bytes += await api.download(`${regionDirectory}/${firstName}`, path.join(staging, 'region', firstName), first.size, maxBytes - bytes);
      for (const name of names.filter((entry) => entry !== firstName)) {
        await check();
        const remote = `${regionDirectory}/${name}`;
        const info = await api.json(`/files/info/${encodedPath(remote)}/`);
        if (info.isDirectory || info.isReadable !== true) throw new SnapshotUnavailable('exaroton denied a world file download; the incomplete snapshot was discarded.');
        // Every region is re-downloaded; equal sizes do not imply equal contents.
        bytes += await api.download(remote, path.join(staging, 'region', name), info.size, maxBytes - bytes);
      }
    }
    await check();
    await replaceWorld(staging, path.join(directory, 'world'));
    staging = undefined;
    return { status: 'ready', worldPath: path.join(directory, 'world'), minecraftVersion: server?.software?.version };
  } catch (error) {
    return { status: 'skipped', reason: fallbackReason(interrupted || error) };
  } finally {
    monitor?.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
