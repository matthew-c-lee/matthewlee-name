import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mergeMap, validateExport, validateWeb } from './publish.mjs';

const manifest = { renderedAt: '2026-10-08T12:00:00.000Z', bluemapVersion: '5.28', privatePath: 'must-not-be-published' };
const placeholder = '<!doctype html><title>Awaiting first map</title><p>No map yet.</p>\n';

async function put(root, filename, text) {
  const target = path.join(root, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function fixture(t, { basePath = '', map = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bluemap-publish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const stateDir = path.join(root, 'state');
  const placeholderDir = path.join(root, 'placeholder');
  const webDir = path.join(stateDir, 'current/web');
  await put(outDir, 'index.html', '<h1>Existing homepage</h1>');
  await put(outDir, 'minecraft.html', `<iframe src="${basePath}/bluemap/" title="BlueMap 3D Minecraft map"></iframe><a href="${basePath}/bluemap/">Open full map</a>`);
  await put(outDir, 'bluemap/index.html', placeholder);
  await put(placeholderDir, 'index.html', placeholder);
  if (map) {
    await put(webDir, 'index.html', '<title>BlueMap</title><script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">');
    await put(webDir, 'assets/app.js', 'console.log("BlueMap");');
    await put(webDir, 'assets/app.css', 'body { margin: 0; }');
    await put(webDir, 'lang/cs.conf', 'menu: "Mapa"');
    await put(webDir, 'settings.json', JSON.stringify({ clientDecompression: true, mapDataRoot: 'maps', liveDataRoot: 'maps', maps: ['overworld'] }));
    await put(webDir, 'maps/overworld/settings.json', '{"name":"Overworld"}');
    await put(webDir, 'maps/overworld/textures.json.gz', Buffer.from([31, 139, 8, 0]));
    await put(webDir, 'maps/overworld/tiles/0/0/0.prbm.gz', Buffer.from([31, 139, 8, 0]));
    await put(webDir, 'maps/overworld/tiles/0/0/1.prbm.gz', Buffer.from([31, 139, 8, 0]));
    await put(webDir, 'maps/overworld/rstate/private.regions.dat', 'private render state');
    await put(webDir, 'sql.php', '<?php /* optional SQL handler */ ?>');
    await put(stateDir, 'current/manifest.json', JSON.stringify(manifest));
    await put(stateDir, 'current/render.json', JSON.stringify({ version: '5.28', webFiles: [
      'index.html', 'settings.json', 'assets/app.js', 'assets/app.css', 'lang/cs.conf', 'maps/overworld/settings.json',
      'maps/overworld/textures.json.gz', 'maps/overworld/tiles/0/0/0.prbm.gz', 'maps/overworld/tiles/0/0/1.prbm.gz', 'sql.php',
    ] }));
  }
  return { root, outDir, stateDir, ...(map ? { webDir } : {}), placeholderDir, basePath };
}

test('merges one complete export at a repository base path and excludes private render state', async t => {
  const fixturePaths = await fixture(t, { basePath: '/matthewlee-name' });
  const result = await mergeMap(fixturePaths);
  assert.equal(result.generated, true);
  assert.equal(result.mapUrl, '/matthewlee-name/bluemap/');
  assert.match(await readFile(path.join(fixturePaths.outDir, 'index.html'), 'utf8'), /Existing homepage/);
  assert.equal(await readFile(path.join(fixturePaths.outDir, 'bluemap/lang/cs.conf'), 'utf8'), 'menu: "Mapa"');
  await assert.rejects(readFile(path.join(fixturePaths.outDir, 'bluemap/maps/overworld/rstate/private.regions.dat')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(fixturePaths.outDir, 'bluemap/sql.php')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(fixturePaths.webDir, 'maps/overworld/rstate/private.regions.dat'), 'utf8'), 'private render state');
  const status = JSON.parse(await readFile(path.join(fixturePaths.outDir, 'bluemap/map-status.json'), 'utf8'));
  assert.deepEqual(status, { schemaVersion: 1, generated: true, renderedAt: manifest.renderedAt, bluemapVersion: '5.28' });
  assert.ok(result.bytes > 0);
});

test('candidate override is validated before touching the existing export', async t => {
  const fixturePaths = await fixture(t);
  await mergeMap(fixturePaths);
  const before = await readFile(path.join(fixturePaths.outDir, 'bluemap/map-status.json'), 'utf8');
  await put(fixturePaths.webDir, 'settings.json', JSON.stringify({ clientDecompression: false, maps: ['overworld'] }));
  await assert.rejects(mergeMap({ ...fixturePaths, webDir: fixturePaths.webDir, manifest }), /client-decompression/);
  assert.equal(await readFile(path.join(fixturePaths.outDir, 'bluemap/map-status.json'), 'utf8'), before);
});

test('an explicitly supplied incomplete candidate cannot become a placeholder', async t => {
  const fixturePaths = await fixture(t, { map: false });
  await assert.rejects(mergeMap({ ...fixturePaths, webDir: path.join(fixturePaths.root, 'missing-candidate') }), /candidate BlueMap web output is missing/);
});

test('a skipped refresh cannot publish retained state missing one of its rendered tiles', async t => {
  const fixturePaths = await fixture(t);
  const { webDir, ...retainedOptions } = fixturePaths;
  await mergeMap(retainedOptions);
  const before = await readFile(path.join(fixturePaths.outDir, 'bluemap/maps/overworld/tiles/0/0/1.prbm.gz'));
  await rm(path.join(webDir, 'maps/overworld/tiles/0/0/1.prbm.gz'));
  await assert.rejects(mergeMap(retainedOptions), /retained map is incomplete/);
  assert.deepEqual(await readFile(path.join(fixturePaths.outDir, 'bluemap/maps/overworld/tiles/0/0/1.prbm.gz')), before);
});

test('rejects missing renderer inventory and unsafe inventory paths', async t => {
  const fixturePaths = await fixture(t);
  await rm(path.join(fixturePaths.stateDir, 'current/render.json'));
  await assert.rejects(mergeMap(fixturePaths), { code: 'ENOENT' });
  await assert.rejects(mergeMap({ ...fixturePaths, renderManifest: { webFiles: [] } }), /complete renderer file inventory/);
  await assert.rejects(mergeMap({ ...fixturePaths, renderManifest: { webFiles: ['../private.txt'] } }), /unsafe path/);
  await assert.rejects(mergeMap({ ...fixturePaths, renderManifest: { webFiles: ['C:/private.txt'] } }), /unsafe path/);
  await assert.rejects(mergeMap({ ...fixturePaths, renderManifest: { webFiles: ['maps/overworld/rstate/private.regions.dat'] } }), /Private file/);
});

test('preserves the export when a final integration check fails', async t => {
  const fixturePaths = await fixture(t);
  const before = await readFile(path.join(fixturePaths.outDir, 'bluemap/index.html'), 'utf8');
  await assert.rejects(mergeMap({ ...fixturePaths, basePath: '/wrong-repository' }), /iframe/);
  assert.equal(await readFile(path.join(fixturePaths.outDir, 'bluemap/index.html'), 'utf8'), before);
});

test('rejects private world files, token contents, hard links and oversized exports', async t => {
  const fixturePaths = await fixture(t);
  await mergeMap(fixturePaths);
  await put(fixturePaths.outDir, 'bluemap/level.dat', 'world');
  await assert.rejects(validateExport(fixturePaths.outDir), /Private file/);
  await rm(path.join(fixturePaths.outDir, 'bluemap/level.dat'));
  await put(fixturePaths.outDir, 'bluemap/core.conf', 'private renderer configuration');
  await assert.rejects(validateExport(fixturePaths.outDir), /Private file/);
  await rm(path.join(fixturePaths.outDir, 'bluemap/core.conf'));
  await put(fixturePaths.outDir, 'leaked.txt', 'before-test-secret-token-after');
  await assert.rejects(validateExport(fixturePaths.outDir, { token: 'test-secret-token' }), /API token/);
  await rm(path.join(fixturePaths.outDir, 'leaked.txt'));
  await link(path.join(fixturePaths.outDir, 'index.html'), path.join(fixturePaths.outDir, 'hardlink.html'));
  await assert.rejects(validateExport(fixturePaths.outDir), /Hard links/);
  await rm(path.join(fixturePaths.outDir, 'hardlink.html'));
  await assert.rejects(validateExport(fixturePaths.outDir, { maxBytes: 100 }), /1 GB size limit/);
});

test('rejects missing assets and map roots requiring an application server', async t => {
  const fixturePaths = await fixture(t);
  await rm(path.join(fixturePaths.webDir, 'assets/app.js'));
  await assert.rejects(validateWeb(fixturePaths.webDir), /asset is missing/);
  await put(fixturePaths.webDir, 'assets/app.js', '');
  await put(fixturePaths.webDir, 'settings.json', JSON.stringify({ clientDecompression: true, mapDataRoot: '/sql.php', maps: ['overworld'] }));
  await assert.rejects(validateWeb(fixturePaths.webDir), /relative static paths/);
});

test('credential-free initial export uses its placeholder after published paths return 404', async t => {
  const fixturePaths = await fixture(t, { map: false });
  const urls = [];
  const result = await mergeMap({ ...fixturePaths, siteUrl: 'https://example.github.io/repository', fetchImpl: async url => {
    urls.push(url.href);
    return new Response(null, { status: 404 });
  } });
  assert.equal(result.generated, false);
  assert.deepEqual(urls, ['https://example.github.io/repository/bluemap/map-status.json', 'https://example.github.io/repository/bluemap/index.html']);
  assert.equal(await readFile(path.join(fixturePaths.outDir, 'bluemap/index.html'), 'utf8'), placeholder);
});

test('missing retained state cannot replace a previously published generated map', async t => {
  const fixturePaths = await fixture(t, { map: false });
  await assert.rejects(mergeMap({ ...fixturePaths, siteUrl: 'https://example.com', fetchImpl: async () => Response.json({ generated: true }) }), /refusing to replace/);
});

test('detects a legacy published map even without its status marker', async t => {
  const fixturePaths = await fixture(t, { map: false });
  await assert.rejects(mergeMap({ ...fixturePaths, siteUrl: 'https://example.com', fetchImpl: async url => url.pathname.endsWith('.json')
    ? new Response(null, { status: 404 }) : new Response('<title>BlueMap generated map</title>') }), /refusing to replace/);
});

test('allows an exact known published placeholder and fails closed on unknown responses', async t => {
  const fixturePaths = await fixture(t, { map: false });
  const result = await mergeMap({ ...fixturePaths, siteUrl: 'https://example.com', fetchImpl: async url => url.pathname.endsWith('.json')
    ? Response.json({ generated: false }) : new Response(placeholder) });
  assert.equal(result.generated, false);
  await assert.rejects(mergeMap({ ...fixturePaths, siteUrl: 'https://example.com', fetchImpl: async () => new Response('Access denied', { status: 403 }) }), /deployment is stopped/);
});
