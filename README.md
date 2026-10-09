# Matthew's site

This is the existing Next.js 14 static site, including its MDX Minecraft travel guide.
`/minecraft` embeds the generated BlueMap Overworld at `/bluemap/` and links to the full map.
Until a render succeeds, that URL shows a placeholder. The browser never contacts exaroton.

## GitHub configuration

Under **Settings > Secrets and variables > Actions**, create exactly these required entries:

| Type | Name | Value |
| --- | --- | --- |
| Repository secret | `EXAROTON_API_TOKEN` | Your exaroton API token; create/manage it in your exaroton account. |
| Repository variable | `EXAROTON_SERVER_ID` | `bc65z7fmasnQAETT` (your verified server API ID). |

Optional repository variable `EXAROTON_WORLD_PATH` changes the Overworld directory (default
`world`). It is a relative server path, for example `my-world`; it must contain `level.dat`.
The script discovers classic `region/` and Minecraft 26.1+ `dimensions/minecraft/overworld/region/`.
Optional `EXAROTON_REGION_PATH` overrides the region directory relative to that world root.
[Minecraft's world-storage changes](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1)

This integration renders only the Overworld. Additional dimensions need their
own snapshot selection and BlueMap map configuration.

Keep **Settings > Pages > Build and deployment > Source** set to **GitHub Actions**, and
preserve the existing custom-domain setting `matthewlee.name`. The tracked `CNAME` is copied
into the export. For custom Actions deployments, GitHub uses the Pages domain setting rather
than reading `CNAME`. [GitHub custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

The existing push-to-`main` deployment and manual **Actions > Deploy Next.js site to Pages >
Run workflow** (select `main`) both build the complete website and attempt a map refresh. Manual
runs on other branches skip production deployment so their state cannot bypass main's recovery history. Leave the server
offline throughout snapshot collection. The scripts never start or stop it. If it is online,
credentials are missing, or file access fails, the workflow keeps the last complete map and
can still deploy website changes. A refresh failure is reported in the Actions step summary.

For scheduled refreshes, uncomment the `schedule` block in `.github/workflows/nextjs.yml`.
The example runs at 06:17 UTC. Schedules run on the default branch, may be delayed, and public
repository schedules can be disabled after 60 days of inactivity. They do not make the
Minecraft server go offline. [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## exaroton file access and fallback

The script uses only documented **GET** server, file-info and file-data endpoints. It checks
`isReadable` and actually downloads/validates `level.dat` and one `.mca` before collecting the
remaining regions. Binary validation uses the actual NBT/MCA contents because exaroton may
label binary responses with an HTML content type. An API token does not establish that your
account can download binary
world files. There is no world-ZIP API endpoint used here. [Official exaroton API](https://developers.exaroton.com/)

Snapshots require status `0` (OFFLINE). A read-only status WebSocket plus REST checks detect
status transitions, including a quick start/stop; a transition or disconnected monitor
discards the snapshot. Every selected region is downloaded again, including equal-size files,
and its external `.mcc` chunk files are included. Transfers have bounded retries/timeouts and atomic
file writes; incomplete snapshots never become renderer input.

Only Overworld `level.dat`, `r.<x>.<z>.mca` and `c.<x>.<z>.mcc` files are selected.
Nether, End, entities, player data, mods and Distant Horizons databases are excluded.
The downloader uses the map's single finite box mask to select intersecting regions,
including a 32-block border for neighboring terrain. Region files cover 512 x 512 blocks;
the current bounds require at most 36 region files, plus their external chunks. Other mask
shapes, multiple masks or unbounded masks conservatively download the full Overworld.
The same selection applies to supplied folders and ZIPs; ZIPs are still fully extracted
privately under the existing safety and size checks before the relevant files are copied.
Download logs report the selected region count and completed snapshot size.

Zero-byte `.mca` files are retained as empty regions, matching BlueMap's own reader. This
also lets incremental rendering remove terrain that no longer exists. The binary permission
probe selects a non-empty region. Empty `level.dat` or `.mcc` files still fail validation, and
an empty response for a file advertised as non-empty is retried rather than accepted.
[BlueMap's region reader](https://github.com/BlueMap-Minecraft/BlueMap/blob/v5.28/core/src/main/java/de/bluecolored/bluemap/core/world/mca/region/MCARegion.java)

If file-info or binary downloads are restricted, download the world while offline from the
exaroton **Worlds** page in your browser, then supply its folder or ZIP locally through
`BLUEMAP_WORLD_SOURCE`. [Official world download instructions](https://support.exaroton.com/hc/en-us/articles/360019857598-Download-your-world)

For CI fallback, make an offline world available at a runner-local path before the refresh
step, and set optional repository variable `BLUEMAP_WORLD_SOURCE` to that path. The workflow
does not upload your world or fetch an arbitrary private archive automatically. Add your
own authenticated download/extraction step if you maintain a private snapshot elsewhere;
keep it outside `public/` and `out/`. Alternatively, render locally and restore its state
archive using the procedure below. A local folder/ZIP is a previously collected offline
snapshot; without exaroton credentials the script cannot verify when you exported it. With
credentials present it also checks that the remote server stays offline during import.

## Local use

Use Node.js 20.12 or later, Java 25 or later, and Python 3.9 or later for ZIP input only.
Copy `.env.example` to `.env` and fill in either the exaroton values or
`BLUEMAP_WORLD_SOURCE=/absolute/path/to/offline-world.zip` (an unpacked folder also works).
Real `.env` files, tools, worlds, renderer state and tiles are ignored by Git. Never put the
token in `NEXT_PUBLIC_*`, Next.js configuration, URLs, or published files.

```sh
npm ci
npm run lint
npm run map:test
npm run build
npm run map:refresh
```

`map:refresh` loads `.env`, renders if possible, merges into an **existing** `out/`, validates
the complete export, and commits successful renderer state. Build first. `npm run build`
alone works without credentials and exports the placeholder. `npm run map:publish` merges
an already rendered/restored map without contacting exaroton. Serve `out/` with a static
HTTP server to preview the iframe and full map; `next start` is not a static-export server.

Local `JAVA_HOME` selects your JDK and `PYTHON` can specify the Python executable. Optional
`BLUEMAP_MINECRAFT_VERSION` overrides version detection from `level.dat` for older world metadata.
The pin is BlueMap **5.28**, whose CLI supports stable Minecraft Java **1.13.2–1.21.11** and
**26.1–26.3**, and requires Java **25+**. Optional
`EXAROTON_TIMEOUT_MS` defaults to 120000 per request and `BLUEMAP_WORLD_MAX_BYTES` defaults to
8 GiB for the private snapshot. These are snapshot limits, separate from the smaller Pages
publication limit. Overlarge maps need tighter BlueMap map bounds in `bluemap/maps/overworld.conf`.

The required MDX loader/React peers and MDX types were absent from the original dependency
setup; they are pinned additions. Existing framework and dependency versions are retained.
The required App Router `src/mdx-components.tsx` passes existing elements through.
[Next.js MDX setup](https://nextjs.org/docs/14/app/building-your-application/configuring/mdx)

## Renderer and static paths

The Overworld map is limited to a **2,500 x 2,500-block square centered on X=0, Z=0**:
X and Z run from -1250 through 1249, with no height restriction. The box `render-mask`
in `bluemap/maps/overworld.conf` is the single shared setting for downloading and rendering;
change its four limits to move
or enlarge the map. This restricts rendered terrain and generated map size, and snapshot
collection automatically limits downloads to nearby regions using the same box bounds.
Changing the map configuration invalidates the saved render fingerprint and starts a
fresh render within the new bounds. The last complete map is kept until that succeeds.
[BlueMap render masks](https://bluemap.bluecolored.de/wiki/customization/Masks.html)

The BlueMap renderer timeout and Actions build-job timeout are both **six hours**.
GitHub's hosted-runner limit applies to the whole job, including setup, snapshot downloads,
rendering and artifact uploads, so CI has less than six hours available for rendering.
An unfinished render is discarded; only complete renders are saved and published.
[GitHub Actions execution limits](https://docs.github.com/en/actions/reference/limits)

The standalone BlueMap CLI is pinned in `scripts/bluemap/render.mjs`, with an official
release SHA-256 check, and CI installs Java 25. Templates under `bluemap/` use FILE storage,
gzip tiles, `client-decompression: true`, relative `maps` URLs, and no built-in webserver.
BlueMap downloads the Minecraft resources it needs from Mojang (`accept-download: true`).
Your exact Minecraft version must be supported by the pinned CLI; the renderer reads the
world metadata, and an unsupported world leaves the prior map in place. Do not silently
upgrade the renderer when upgrading Minecraft: verify the release notes and Java requirement,
then deliberately update the pin, checksum, templates, and tests.
[BlueMap releases](https://github.com/BlueMap-Minecraft/BlueMap/releases),
[standalone CLI](https://bluemap.bluecolored.de/wiki/getting-started/Installation.html),
[FILE storage](https://bluemap.bluecolored.de/wiki/configs/storages/File.html),
[web app configuration](https://bluemap.bluecolored.de/wiki/configs/Webapp.html)

`actions/configure-pages` supplies the build-time `PAGES_BASE_PATH`. It is empty for the
existing custom domain and `/repository-name` for repository Pages hosting. The same value
configures Next.js and the iframe/full-map link. For local repository-path tests set it in
the build environment and again for `map:refresh`/`map:publish`. The exported map remains
physically in `out/bluemap/`; do not nest a second repository directory in `out/`.
BlueMap resolves assets and tiles relative to its own `/bluemap/` URL.
[Next.js basePath](https://nextjs.org/docs/14/app/api-reference/next-config-js/basePath),
[static export](https://nextjs.org/docs/14/app/building-your-application/deploying/static-exports),
[Configure Pages outputs](https://github.com/actions/configure-pages/blob/v5/action.yml)

## State, publication and recovery

Successful renderer data and web output live in `.bluemap/current/`. Rendering uses a
separate transaction, reusing complete state for incremental updates. Missing or incompatible
render caches cause a fresh render; the old web output stays available until replacement
passes validation. Private FILE `rstate` is retained for rendering and stripped from publication.
Raw world files, configuration, renderer data and logs never enter `out/`.

The workflow restores `bluemap-state` only from successful `main` runs of this workflow.
Each successful run, including skipped refreshes, renews a separate 90-day state artifact
containing `data/`, `web/`, `render.json` and `manifest.json`. This is separate from the sole Pages artifact:
one deployment publishes the entire existing website plus `out/bluemap/`. The workflow's
existing `pages` concurrency group serializes map collection and deployment without
cancelling an active run. Failed build/validation/upload prevents deployment.

Actions artifacts expire and count against your Actions storage allowance. Keep a downloaded
backup of `bluemap-state/state.tar.gz`, particularly before a long inactive period. Renderer
data is not a secret store; artifacts are accessible to repository readers. The archive does
not contain the API token or raw world. If all state expires, a new complete render can
rebuild it. If that cannot succeed, the script checks the published map marker/index and
stops deployment instead of overwriting a live map with the placeholder. Failure to check
the published site also stops deployment. [GitHub artifact storage and retention](https://docs.github.com/en/actions/tutorials/store-and-share-data)

To restore a backup locally, unpack `state.tar.gz` into `.bluemap/current/` so its immediate
children are `data/`, `web/`, `render.json` and `manifest.json`, then build and run `map:publish`. For CI
recovery, add a temporary step to restore that same trusted archive before the refresh step,
run the workflow on `main`, then remove the temporary recovery step. Store that backup
privately outside this repository; do not commit it or the world to Git.

Publication validates the iframe/link, relative BlueMap assets, generated map settings and
tiles, `CNAME`, token absence, and exclusion of private files and links. It measures the
**combined uncompressed website and map** and rejects output at or above 1,000,000,000 bytes,
below GitHub's 1 GB site limit. No actual world-size assertion is possible until your world
has rendered. Pages also has a 10-minute deployment timeout and a soft bandwidth limit;
large maps may need reduced map bounds or different map hosting.
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

On 2026-10-08, a read-only check with your supplied credentials confirmed Minecraft **26.2**,
the modern Overworld path, valid downloaded `level.dat`, and one complete valid `.mca`
(9,043,968 bytes), while continuously observing OFFLINE status. The region directory contains
968 `.mca` files totaling 3,289,878,528 bytes. This confirms binary API access for your account;
the entire real world has not been downloaded/rendered yet, and its final map size has not
been measured. The original token was used only in memory and is not stored in this project.

Completed implementation checks: existing lint; all 47 map tests (including actual ZIP
extraction); production export with both custom-domain and repository base paths; and
combined iframe, full-map link, assets, CNAME and size validation. Actual Java 25/BlueMap 5.28
renders of a small synthetic Minecraft 26.2 world produced compressed 3D tiles, reused
incremental state, and rebuilt successfully after a cache file was removed. That generated
map merged with the complete website passed validation at 8,142,166 bytes. These synthetic
checks do not establish the eventual size or render time of your full real world. GitHub
Actions artifact recovery and Pages deployment still need their first repository workflow run.

If a refresh is skipped, inspect its reason in the workflow log: offline status, readable
world path, real binary download permission, Python/ZIP validity, or snapshot limit. A render
failure keeps the previous map; check the compatible Java runtime and pinned release's world
support. Detailed renderer logs, when available, stay in ignored local state. The scripts
intentionally avoid logging raw API error bodies or credentials.
