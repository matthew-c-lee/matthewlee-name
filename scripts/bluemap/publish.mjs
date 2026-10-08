import { createReadStream } from 'node:fs';
import { cp, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pagesLimit = 1_000_000_000;
const privateDirectories = new Set(['.git', '.github', '.bluemap', '.tools', 'worlds', 'snapshots', 'renderer', 'rstate', 'config', 'configs', 'logs', 'data']);

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function publicFilename(relative) {
  const segments = relative.toLowerCase().split('/');
  const name = segments.at(-1);
  const publicLanguage = /^(?:bluemap\/)?lang\/[a-z\d_-]+\.conf$/i.test(relative);
  if (segments.some(segment => privateDirectories.has(segment)) ||
      /^\.env(?:\.|$)/.test(name) || /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:[._-]|$)/.test(name) ||
      /^(?:\.npmrc|\.netrc|id_rsa|id_ed25519)$/.test(name) || segments[0] === 'world' ||
      /^(?:level\.dat(?:_old)?|session\.lock|server\.properties)$/.test(name) ||
      /\.(?:mca|mcc|mcr|jar|pem|key|sqlite|sqlite3|db|log|php)$/.test(name) ||
      (/\.conf$/.test(name) && !publicLanguage)) {
    throw new Error(`Private file is not allowed in published output: ${relative}`);
  }
}

async function containsToken(file, token) {
  if (!token) return false;
  const needle = Buffer.from(token);
  let previous = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.concat([previous, chunk]);
    if (buffer.includes(needle)) return true;
    previous = buffer.subarray(Math.max(0, buffer.length - needle.length + 1));
  }
  return false;
}

async function inspectTree(root, { token = process.env.EXAROTON_API_TOKEN, maxBytes = pagesLimit, skipRenderState = false } = {}) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Published output must be a regular directory.');
  const files = [];
  let bytes = 0;
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (skipRenderState && entry.name === 'rstate' && entry.isDirectory()) continue;
      if (skipRenderState && relative === 'sql.php' && entry.isFile()) continue;
      publicFilename(relative);
      const filename = path.join(directory, entry.name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsupported published file: ${relative}`);
      if (stat.isDirectory()) await visit(filename, `${relative}/`);
      else {
        if (stat.nlink !== 1) throw new Error(`Hard links are not allowed in published output: ${relative}`);
        bytes += stat.size;
        if (bytes >= maxBytes) throw new Error('Combined website and map reach the GitHub Pages 1 GB size limit.');
        if (await containsToken(filename, token)) throw new Error('An API token was detected in published output.');
        files.push(relative);
      }
    }
  }
  await visit(root);
  return { files, bytes };
}

async function smallText(filename, maxBytes = 2_000_000) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Map configuration or HTML is missing or unexpectedly large.');
  return readFile(filename, 'utf8');
}

async function validateInventory(webDir, renderManifest, { published = false } = {}) {
  const inventory = renderManifest?.webFiles;
  if (!Array.isArray(inventory) || !inventory.length || inventory.length > 1_000_000 || new Set(inventory).size !== inventory.length) {
    throw new Error('The retained map has no complete renderer file inventory; a full successful render is required.');
  }
  for (const file of inventory) {
    if (typeof file !== 'string' || /^[/\\]/.test(file) || /[\\:\u0000-\u001f]/.test(file) ||
        file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('The renderer file inventory contains an unsafe path.');
    }
    if (file !== 'sql.php') publicFilename(file);
    if (published && file === 'sql.php') continue;
    let stat;
    try { stat = await lstat(path.join(webDir, file)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`The retained map is incomplete: ${file}`);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`The retained map contains an invalid file: ${file}`);
  }
}

function relativeResource(resource) {
  if (typeof resource !== 'string' || !resource || /^[a-z][a-z\d+.-]*:|^[/\\]/i.test(resource)) {
    throw new Error('BlueMap must load its assets and map files from relative static paths.');
  }
  const decoded = decodeURIComponent(resource.split(/[?#]/, 1)[0]);
  const normalized = path.posix.normalize(decoded);
  if (decoded.includes('\\') || normalized === '..' || normalized.startsWith('../') || /\.php$/i.test(normalized)) {
    throw new Error('BlueMap contains a path requiring a server or escaping its web directory.');
  }
  return normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

export async function validateWeb(webDir, options = {}) {
  const { files, bytes } = await inspectTree(webDir, { ...options, skipRenderState: true });
  const html = await smallText(path.join(webDir, 'index.html'));
  const settings = JSON.parse(await smallText(path.join(webDir, 'settings.json')));
  if (settings.clientDecompression !== true && settings['client-decompression'] !== true) {
    throw new Error('Static BlueMap hosting requires client-decompression: true.');
  }
  const mapRoot = relativeResource(settings.mapDataRoot ?? settings['map-data-root'] ?? 'maps');
  relativeResource(settings.liveDataRoot ?? settings['live-data-root'] ?? 'maps');
  if (mapRoot !== 'maps') throw new Error('BlueMap FILE storage must be published under its relative maps directory.');
  let scripts = 0;
  for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const attribute = tag[0].match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i);
    if (!attribute || /^data:/i.test(attribute[1])) continue;
    const resource = relativeResource(attribute[1]);
    if (!files.includes(resource)) throw new Error(`BlueMap asset is missing: ${resource}`);
    if (/^<script\b/i.test(tag[0]) && /\.js$/i.test(resource)) scripts++;
  }
  if (!scripts) throw new Error('BlueMap has no generated JavaScript application.');
  if (!Array.isArray(settings.maps) || !settings.maps.length) throw new Error('BlueMap contains no configured maps.');
  for (const map of settings.maps) {
    const id = typeof map === 'string' ? map : map.id;
    if (typeof id !== 'string' || !/^[a-z\d_-]+$/i.test(id)) throw new Error('BlueMap has an invalid map identifier.');
    const mapPrefix = `maps/${id}/`;
    JSON.parse(await smallText(path.join(webDir, `${mapPrefix}settings.json`)));
    const texture = await lstat(path.join(webDir, `${mapPrefix}textures.json.gz`));
    if (!texture.isFile() || texture.size === 0) throw new Error(`BlueMap textures are missing for map ${id}.`);
    if (!files.some(file => file.startsWith(`${mapPrefix}tiles/`))) throw new Error(`BlueMap tiles are missing for map ${id}.`);
  }
  return { bytes, maps: settings.maps.length };
}

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  if (!/^\/(?:[a-z\d._~-]+\/)*[a-z\d._~-]+$/i.test(value)) throw new Error('Invalid Pages base path.');
  return value;
}

export async function validateExport(outDir, { basePath = '', token = process.env.EXAROTON_API_TOKEN, maxBytes = pagesLimit } = {}) {
  const inspected = await inspectTree(outDir, { token, maxBytes });
  const mapUrl = `${normalizeBasePath(basePath)}/bluemap/`;
  const pageFile = inspected.files.find(file => file === 'minecraft.html' || file === 'minecraft/index.html');
  if (!pageFile) throw new Error('The existing Minecraft page is missing from the static export.');
  const html = await smallText(path.join(outDir, pageFile));
  const iframe = [...html.matchAll(/<iframe\b[^>]*>/gi)].find(match => match[0].includes(`src="${mapUrl}"`) || match[0].includes(`src='${mapUrl}'`));
  if (!iframe || !/\btitle=["'][^"']*(?:Minecraft|BlueMap)[^"']+["']/i.test(iframe[0])) throw new Error('The Minecraft map iframe path or accessible title is incorrect.');
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (!links.some(([, attributes, text]) => (attributes.includes(`href="${mapUrl}"`) || attributes.includes(`href='${mapUrl}'`)) && /Open full map/i.test(text))) {
    throw new Error('The Minecraft page is missing its Open full map link.');
  }
  await smallText(path.join(outDir, 'bluemap/index.html'));
  const cname = await smallText(path.join(projectRoot, 'CNAME'));
  if ((await smallText(path.join(outDir, 'CNAME'))).trim() !== cname.trim()) throw new Error('The existing CNAME was not preserved.');
  if (await exists(path.join(outDir, 'bluemap/settings.json'))) await validateWeb(path.join(outDir, 'bluemap'), { token, maxBytes });
  return { bytes: inspected.bytes, mapUrl };
}

async function publishedResponse(url, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { Accept: 'application/json, text/html' } });
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: 404, text: '' };
      }
      if (response.status === 200) {
        let body = '';
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 1_000_000) throw new Error('Published map response is unexpectedly large.');
          body += Buffer.from(chunk).toString('utf8');
        }
        return { status: 200, text: body };
      }
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) throw new Error('Published map could not be checked safely.');
    } catch (error) {
      if (attempt === 2) throw new Error('Published map could not be checked safely; deployment is stopped.', { cause: error });
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('Published map could not be checked safely; deployment is stopped.');
}

async function guardPublishedMap(siteUrl, placeholder, fetchImpl) {
  const base = new URL(`${siteUrl.replace(/\/$/, '')}/`);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid published site URL.');
  const marker = await publishedResponse(new URL('bluemap/map-status.json', base), fetchImpl);
  if (marker.status === 200) {
    let status;
    try { status = JSON.parse(marker.text); } catch { throw new Error('Published map status is invalid; deployment is stopped.'); }
    if (status.generated !== false) throw new Error('A published map exists but its last successful files are unavailable; refusing to replace it with a placeholder.');
  }
  const index = await publishedResponse(new URL('bluemap/index.html', base), fetchImpl);
  if (index.status === 404 && marker.status === 404) return;
  if (index.status === 200 && index.text.trim() === placeholder.trim()) return;
  throw new Error('A published map exists or its state is unknown; refusing to replace it with a placeholder.');
}

export async function mergeMap({ stateDir = '.bluemap', outDir = 'out', basePath = '', siteUrl, webDir, manifest, renderManifest,
  placeholderDir = path.join(projectRoot, 'public/bluemap'), token = process.env.EXAROTON_API_TOKEN, fetchImpl = fetch } = {}) {
  const output = path.resolve(outDir);
  const candidateWeb = webDir ?? path.join(stateDir, 'current/web');
  const generated = await exists(candidateWeb);
  if (webDir && !generated) throw new Error('The candidate BlueMap web output is missing.');
  const source = generated ? candidateWeb : placeholderDir;
  await inspectTree(output, { token });
  if (generated) {
    await validateWeb(source, { token });
    renderManifest ??= JSON.parse(await smallText(path.join(path.dirname(source), 'render.json'), 64_000_000));
    await validateInventory(source, renderManifest);
  }
  else {
    const placeholder = await smallText(path.join(source, 'index.html'));
    if (siteUrl) await guardPublishedMap(siteUrl, placeholder, fetchImpl);
  }
  const suffix = randomUUID();
  const staging = path.join(path.dirname(output), `.bluemap-publish-${suffix}`);
  const backup = path.join(path.dirname(output), `.bluemap-publish-backup-${suffix}`);
  let movedOutput = false;
  try {
    await cp(output, staging, { recursive: true });
    await rm(path.join(staging, 'bluemap'), { recursive: true, force: true });
    await cp(source, path.join(staging, 'bluemap'), {
      recursive: true,
      filter: filename => {
        const relative = path.relative(source, filename);
        return path.basename(filename) !== 'sql.php' && !relative.split(path.sep).includes('rstate');
      },
    });
    if (generated) await validateInventory(path.join(staging, 'bluemap'), renderManifest, { published: true });
    await cp(path.join(projectRoot, 'CNAME'), path.join(staging, 'CNAME'));
    let state = manifest;
    if (generated && !state) state = JSON.parse(await smallText(path.join(stateDir, 'current/manifest.json')));
    const status = { schemaVersion: 1, generated };
    if (generated) {
      status.renderedAt = state.renderedAt ?? state.completedAt;
      status.bluemapVersion = state.bluemapVersion ?? state.version;
      if (typeof status.renderedAt !== 'string' || !Number.isFinite(Date.parse(status.renderedAt)) || typeof status.bluemapVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(status.bluemapVersion)) {
        throw new Error('Successful map state is missing its render timestamp or pinned BlueMap version.');
      }
      status.renderedAt = new Date(status.renderedAt).toISOString();
    }
    await writeFile(path.join(staging, 'bluemap/map-status.json'), `${JSON.stringify(status, null, 2)}\n`);
    const result = await validateExport(staging, { basePath, token });
    await rename(output, backup);
    movedOutput = true;
    await rename(staging, output);
    await rm(backup, { recursive: true, force: true });
    return { generated, ...result };
  } catch (error) {
    if (movedOutput && !(await exists(output))) await rename(backup, output);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    try { process.loadEnvFile('.env'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await mergeMap({ basePath: process.env.PAGES_BASE_PATH || '', siteUrl: process.env.PAGES_SITE_URL || undefined });
    console.log(`Validated complete Pages export: ${result.bytes} bytes; map URL ${result.mapUrl}; generated map: ${result.generated}.`);
  } catch {
    console.error('Map publication validation failed; the existing output was retained. Build first and check the README recovery instructions.');
    process.exitCode = 1;
  }
}
