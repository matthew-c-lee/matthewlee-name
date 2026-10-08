import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSnapshot } from './snapshot.mjs';
import { renderSnapshot } from './render.mjs';
import { mergeMap } from './publish.mjs';

async function loadLocalEnvironment() {
  try { process.loadEnvFile('.env'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load the local .env file.'); }
}

export async function refresh({ stateDir = '.bluemap', outDir = 'out', env = process.env } = {}) {
  await mkdir(stateDir, { recursive: true });
  const basePath = env.PAGES_BASE_PATH || '';
  const siteUrl = env.PAGES_SITE_URL || undefined;
  let candidateDir;
  let refreshStatus = 'skipped';
  try {
    const snapshot = await acquireSnapshot({ stateDir, env });
    if (snapshot.status === 'ready') {
      const rendered = await renderSnapshot({ stateDir, worldPath: snapshot.worldPath,
        sourceKey: JSON.stringify({ server: env.EXAROTON_SERVER_ID, world: env.EXAROTON_WORLD_PATH || 'world', region: env.EXAROTON_REGION_PATH || '', source: env.BLUEMAP_WORLD_SOURCE || '' }) });
      candidateDir = rendered.candidateDir;
      const manifest = {
        schemaVersion: 1,
        renderedAt: new Date().toISOString(),
        bluemapVersion: rendered.version,
      };
      await writeFile(path.join(candidateDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      await mergeMap({ stateDir, outDir, basePath, siteUrl, webDir: rendered.webDir, manifest });

      // Commit only a complete render whose combined website passed validation.
      const current = path.join(stateDir, 'current');
      const backup = path.join(stateDir, 'previous');
      await rm(backup, { recursive: true, force: true });
      let hadCurrent = false;
      try { await rename(current, backup); hadCurrent = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(candidateDir, current); }
      catch (error) { if (hadCurrent) await rename(backup, current); throw error; }
      candidateDir = undefined;
      await rm(backup, { recursive: true, force: true });
      await rm(path.join(current, 'world'), { recursive: true, force: true });
      await rm(path.join(current, 'config'), { recursive: true, force: true });
      refreshStatus = 'rendered';
      console.log('BlueMap refresh completed; the combined website is ready.');
    } else {
      console.log(`BlueMap refresh skipped: ${snapshot.reason}`);
    }
  } catch {
    // Never echo API responses, environment values, or credential-bearing errors.
    refreshStatus = 'failed';
    console.warn('BlueMap refresh failed. Retaining the last successful map; see README troubleshooting.');
  } finally {
    if (candidateDir) await rm(candidateDir, { recursive: true, force: true });
    await rm(path.join(stateDir, 'world'), { recursive: true, force: true });
  }

  if (refreshStatus !== 'rendered') await mergeMap({ stateDir, outDir, basePath, siteUrl });
  // A retained state archive needs only these files, never the snapshot/configuration.
  let hasState = false;
  try { await readFile(path.join(stateDir, 'current', 'manifest.json')); hasState = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `has-state=${hasState}\nrefresh-status=${refreshStatus}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `BlueMap refresh: **${refreshStatus}**. ${hasState ? 'A complete generated map is included.' : 'No generated map yet; the placeholder is included.'}\n`);
  }
  return { refreshStatus, hasState };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await loadLocalEnvironment(); await refresh(); }
  catch { console.error('BlueMap output validation failed; deployment must stop to protect the published map.'); process.exitCode = 1; }
}
