import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const BLUEMAP_VERSION = "5.28";
export const BLUEMAP_SHA256 = "c6868465f8f972a64a3f2acc32112cab8560339045747f81359bdea6959f7ac2";
export const JAVA_MINIMUM_VERSION = 25;
const downloadUrl = `https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v${BLUEMAP_VERSION}/bluemap-${BLUEMAP_VERSION}-cli.jar`;
const templateDir = fileURLToPath(new URL("../../bluemap/", import.meta.url));
const configurationFiles = ["core.conf", "webapp.conf", "webserver.conf", "storages/file.conf", "maps/overworld.conf"];

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function ensureRenderer(stateDir) {
  const jarPath = resolve(stateDir, "tools", `bluemap-${BLUEMAP_VERSION}-cli.jar`);
  await mkdir(dirname(jarPath), { recursive: true });
  if (await exists(jarPath) && await digest(jarPath) === BLUEMAP_SHA256) return jarPath;

  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${jarPath}.${randomUUID()}.part`;
    try {
      const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`BlueMap download returned HTTP ${response.status}.`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      if (await digest(temporary) !== BLUEMAP_SHA256) throw new Error("BlueMap download checksum did not match the pinned official release.");
      // Replace a corrupt cached jar only after the complete download is verified.
      await rm(jarPath, { force: true });
      await rename(temporary, jarPath);
      return jarPath;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 2) throw error;
      await delay(1000 * 2 ** attempt);
    }
  }
}

function javaExecutable() {
  return process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
}

// The renderer has no reason to inherit API or GitHub credentials.
function rendererEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|EXAROTON/i.test(key)));
}

async function runJava(args, { cwd, timeoutMs = 7_200_000, log = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(javaExecutable(), args, {
      cwd,
      env: rendererEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostics = false;
    let lineBuffer = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        output = (output + chunk).slice(-65_536);
        lineBuffer += chunk;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop();
        if (lines.some(line => /\b(ERROR|SEVERE)\b/.test(line))) diagnostics = true;
        if (log) process.stdout.write(chunk);
      });
    }
    child.once("error", error => { clearTimeout(timer); reject(new Error(`Unable to launch Java ${JAVA_MINIMUM_VERSION}+: ${error.code || error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("BlueMap exceeded the two-hour rendering timeout."));
      else if (code !== 0 || (log && (diagnostics || /\b(ERROR|SEVERE)\b/.test(lineBuffer)))) reject(new Error(`BlueMap did not complete successfully (exit ${code}). See renderer diagnostics above.`));
      else resolveRun(output);
    });
  });
}

export async function verifyJava() {
  const output = await runJava(["-version"], { timeoutMs: 15_000 });
  const major = Number(/version\s+"(\d+)/.exec(output)?.[1]);
  if (!major || major < JAVA_MINIMUM_VERSION) throw new Error(`BlueMap ${BLUEMAP_VERSION} requires Java ${JAVA_MINIMUM_VERSION} or newer.`);
  return major;
}

// Only retain string values needed for version detection; skip large NBT arrays.
export function readMinecraftVersion(levelDat) {
  const bytes = gunzipSync(levelDat, { maxOutputLength: 16 * 1024 * 1024 });
  let cursor = 0;
  const strings = new Map();
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || cursor + length > bytes.length) throw new Error("Invalid level.dat NBT.");
    const start = cursor; cursor += length; return start;
  }
  function string() { const length = bytes.readUInt16BE(take(2)); return bytes.toString("utf8", take(length), cursor); }
  function count() { return bytes.readInt32BE(take(4)); }
  function payload(type, path, depth = 0) {
    if (depth > 64) throw new Error("level.dat NBT is too deeply nested.");
    if (type >= 1 && type <= 6) { take([0, 1, 2, 4, 8, 4, 8][type]); return; }
    if (type === 7) { take(count()); return; }
    if (type === 8) { strings.set(path, string()); return; }
    if (type === 9) {
      const child = bytes.readUInt8(take(1)); const length = count();
      if (length < 0 || length > 1_000_000) throw new Error("Invalid level.dat NBT list.");
      for (let index = 0; index < length; index++) payload(child, `${path}/${index}`, depth + 1);
      return;
    }
    if (type === 10) {
      while (true) {
        const child = bytes.readUInt8(take(1));
        if (child === 0) return;
        const name = string(); payload(child, `${path}/${name}`, depth + 1);
      }
    }
    if (type === 11 || type === 12) { take(count() * (type === 11 ? 4 : 8)); return; }
    throw new Error("Unsupported level.dat NBT tag.");
  }
  if (bytes.readUInt8(take(1)) !== 10) throw new Error("level.dat must contain an NBT compound.");
  string(); payload(10, "");
  return strings.get("/Data/Version/Name");
}

export function validateMinecraftVersion(version) {
  if (!/^(?:1\.\d+\.\d+|1\.\d+|26\.[1-3](?:\.\d+)?)$/.test(version || "")) {
    throw new Error("Set BLUEMAP_MINECRAFT_VERSION to a supported stable Minecraft Java release (1.13.2–26.3).");
  }
  const numbers = version.split(".").map(Number);
  if (numbers[0] === 1 && (numbers[1] < 13 || (numbers[1] === 13 && (numbers[2] || 0) < 2) || numbers[1] > 21 || (numbers[1] === 21 && (numbers[2] || 0) > 11))) {
    throw new Error(`Minecraft ${version} is outside BlueMap ${BLUEMAP_VERSION}'s supported release range.`);
  }
  return version;
}

async function configFingerprint(minecraftVersion, sourceKey) {
  const hash = createHash("sha256").update(JSON.stringify({ version: BLUEMAP_VERSION, minecraftVersion, sourceKey }));
  for (const file of configurationFiles) hash.update(file).update(await readFile(join(templateDir, file)));
  return hash.digest("hex");
}

async function reusableState(currentDir, fingerprint) {
  try {
    const manifest = JSON.parse(await readFile(join(currentDir, "render.json"), "utf8"));
    if (manifest.fingerprint !== fingerprint || manifest.version !== BLUEMAP_VERSION) return false;
    if (!await exists(join(currentDir, "data")) || !await exists(join(currentDir, "web", "index.html"))) return false;
    if (!(await readdir(join(currentDir, "data"))).length || !Array.isArray(manifest.webFiles)) return false;
    for (const file of manifest.webFiles) {
      if (typeof file !== "string" || file.startsWith("/") || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..")) return false;
      if (!await exists(join(currentDir, "web", file))) return false;
    }
    const inventory = manifest.renderState;
    if (!Array.isArray(inventory) || !inventory.some(file => file.name.endsWith(".chunks.dat")) || !inventory.some(file => file.name.endsWith(".tiles.dat"))) return false;
    const stateRoot = join(currentDir, "web", "maps", "overworld", "rstate");
    for (const file of inventory) {
      if (!/^(?:regions\/)?[xz\d-]+(?:\/[xz\d-]+)*\.(?:chunks|tiles|regions)\.dat$/.test(file.name)) return false;
      const target = join(stateRoot, file.name);
      if (!await exists(target) || await digest(target) !== file.sha256) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function renderStateInventory(candidateDir) {
  const stateRoot = join(candidateDir, "web", "maps", "overworld", "rstate");
  const files = await readdir(stateRoot, { recursive: true, withFileTypes: true });
  const inventory = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const absolute = join(file.parentPath ?? file.path, file.name);
    // BlueMap groups grids by encoded X/Z directory names.
    const name = absolute.slice(stateRoot.length + 1).replaceAll("\\", "/");
    inventory.push({ name, sha256: await digest(absolute) });
  }
  return inventory.sort((left, right) => left.name.localeCompare(right.name));
}

async function webFileInventory(candidateDir) {
  const webRoot = join(candidateDir, "web");
  const files = await readdir(webRoot, { recursive: true, withFileTypes: true });
  return files.filter(file => file.isFile())
    .map(file => join(file.parentPath ?? file.path, file.name).slice(webRoot.length + 1).replaceAll("\\", "/"))
    .filter(file => !file.split("/").includes("rstate"))
    .sort();
}

export async function writeConfiguration(candidateDir) {
  for (const file of configurationFiles) {
    const target = join(candidateDir, "config", file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(templateDir, file)));
  }
}

export async function renderSnapshot({ stateDir, worldPath, sourceKey, minecraftVersion } = {}) {
  if (!stateDir || !worldPath) throw new Error("Rendering requires stateDir and a completed worldPath snapshot.");
  stateDir = resolve(stateDir); worldPath = resolve(worldPath);
  await verifyJava();
  const levelDat = await readFile(join(worldPath, "level.dat"));
  minecraftVersion = validateMinecraftVersion(minecraftVersion || process.env.BLUEMAP_MINECRAFT_VERSION || readMinecraftVersion(levelDat));
  const regions = (await readdir(join(worldPath, "region"))).filter(file => /^r\.-?\d+\.-?\d+\.mca$/.test(file));
  if (!regions.length) throw new Error("The world snapshot has no Overworld region files.");
  sourceKey ??= JSON.stringify({ server: process.env.EXAROTON_SERVER_ID, world: process.env.EXAROTON_WORLD_PATH, source: process.env.BLUEMAP_WORLD_SOURCE || worldPath });
  const fingerprint = await configFingerprint(minecraftVersion, sourceKey);
  const currentDir = join(stateDir, "current");
  const candidateDir = join(stateDir, "transactions", randomUUID());
  const incremental = await reusableState(currentDir, fingerprint);
  await mkdir(candidateDir, { recursive: true });
  try {
    if (incremental) {
      await cp(join(currentDir, "data"), join(candidateDir, "data"), { recursive: true });
      await cp(join(currentDir, "web"), join(candidateDir, "web"), { recursive: true });
    } else {
      console.log("BlueMap render caches are missing or incompatible; creating a complete map from the snapshot.");
    }
    await cp(worldPath, join(candidateDir, "world"), { recursive: true });
    await writeConfiguration(candidateDir);
    const jarPath = await ensureRenderer(stateDir);
    const args = ["-Xmx2G", "-jar", jarPath, "-c", "config", "--mc-version", minecraftVersion, "-r", "-g"];
    if (!incremental) args.push("-f");
    console.log(`Rendering Overworld with BlueMap ${BLUEMAP_VERSION} for Minecraft ${minecraftVersion}.`);
    await runJava(args, { cwd: candidateDir, log: true });
    await stat(join(candidateDir, "web", "index.html"));
    await stat(join(candidateDir, "web", "maps", "overworld", "settings.json"));
    await stat(join(candidateDir, "web", "maps", "overworld", "textures.json.gz"));
    const renderState = await renderStateInventory(candidateDir);
    const webFiles = await webFileInventory(candidateDir);
    const manifest = { version: BLUEMAP_VERSION, minecraftVersion, fingerprint, renderState, webFiles, renderedAt: new Date().toISOString() };
    await writeFile(join(candidateDir, "render.json.tmp"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(join(candidateDir, "render.json.tmp"), join(candidateDir, "render.json"));
    return { candidateDir, webDir: join(candidateDir, "web"), incremental, version: BLUEMAP_VERSION, minecraftVersion };
  } catch (error) {
    // A candidate is disposable; the caller's last successful state is untouched.
    await rm(candidateDir, { recursive: true, force: true });
    throw error;
  }
}
