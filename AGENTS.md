# AGENTS.md: jellyfin-plugin-milkdrop

A Jellyfin 12 server plugin that adds a Butterchurn (MilkDrop 2) visualizer to jellyfin-web and Jellyfin
Desktop. This file is authoritative for the repo; `CLAUDE.md` only points here.

## Stack

- **Server:** C# on .NET 10, `Jellyfin.Controller` 12.2.0 (`ExcludeAssets="runtime"`, the host provides it
  at run time), central package versions in `Directory.Packages.props`, StyleCop + all analyzers with
  warnings as errors.
- **Client:** one plain-JavaScript file, `Jellyfin.Plugin.Milkdrop/Web/milkdrop.js`, no framework, no
  bundler. Its pure helpers are on `MilkdropCore`, exported for Node when loaded outside a browser.
- **Visualizer:** butterchurn 2.6.7 and butterchurn-presets 2.4.7, pinned in `package.json` and
  `package-lock.json`. The csproj copies `lib/butterchurn.min.js` and `lib/butterchurnPresets.min.js` out of
  `node_modules` into `obj/` and embeds them (`BundleButterchurn` target); with no `node_modules` it runs
  `npm ci` once. Never load them from a CDN.
- **Tests:** xunit (`Jellyfin.Plugin.Milkdrop.Tests`) for the C#; `node:test` (`tests/`) for the script's
  helpers. Both run in CI; the Docker build fails on a red C# suite.
- **CI/release:** Forgejo Actions on the shared runner image (node + docker CLI, no dotnet, never apt-get).
  `.forgejo/workflows/ci.yml` builds inside `mcr.microsoft.com/dotnet/sdk:10.0` through the `Dockerfile`.

## Layout

```
meta.json                          plugin manifest in the zip; THE version lives here
manifest.json                      the plugin-repository index Jellyfin polls; CI writes it, never edit by hand
package.json                       pins Butterchurn; `npm test` runs tests/
Dockerfile                         CI build: test + publish in the SDK image, output stage holds the zip's files
Directory.Build.props              JellyfinVersion, TargetFramework, Version (regex over meta.json)
Directory.Packages.props           central package versions
Jellyfin.Plugin.Milkdrop/
  Plugin.cs                        BasePlugin, GUID, VersionString, config page registration
  ServiceRegistrator.cs            registers the IStartupFilter
  Configuration/PluginConfiguration.cs   Enabled, DesktopWebAudio, CycleSeconds, BlendSeconds
  Configuration/configPage.html    the settings page (legacy plugin page; tooltips on each control)
  WebUi/ClientSettings.cs          the clamped settings record and its camel-case JSON
  WebUi/IndexHtmlInjector.cs       pure: builds the tag, inserts it once before </body>
  WebUi/ScriptInjection.cs         IStartupFilter middleware: buffers 200 text/html GET of /web/index.html
                                   (and /web, /web/), rewrites, serves with its own ETag; else passthrough
  Api/MilkdropController.cs        GET Milkdrop/client.js, butterchurn.js, butterchurn-presets.js (anonymous)
  Api/EmbeddedAsset.cs             embedded resource + content-hash ETag + assembly write time
  Api/ConditionalGet.cs            If-None-Match / If-Modified-Since decision
  Web/milkdrop.js                  the client script
Jellyfin.Plugin.Milkdrop.Tests/    xunit
tests/                             node:test for milkdrop.js's MilkdropCore
.forgejo/workflows/ci.yml          build, test, release, manifest
.forgejo/scripts/update-manifest.js  adds a version (md5, URL, timestamp) to manifest.json
```

## Build and test

```bash
npm ci                      # once; fetches the pinned Butterchurn bundles
npm test                    # node:test over tests/
dotnet test                 # restores Jellyfin 12.2.0 packages from NuGet, builds, runs xunit
dotnet publish Jellyfin.Plugin.Milkdrop -c Release -o dist   # dist/Jellyfin.Plugin.Milkdrop.dll
```

A plugin folder for a server is `Jellyfin.Plugin.Milkdrop.dll` + `meta.json` under
`<data>/plugins/Milkdrop_<version>/`. Jellyfin reads `targetAbi` from meta.json and refuses a plugin built
for a newer ABI than the server.

### Local end-to-end check without Docker

This machine has no Docker. The Jellyfin portable build works instead: download
`https://repo.jellyfin.org/files/server/linux/stable/v12.2/amd64/jellyfin_12.2-amd64.tar.gz`, extract, and
run `jellyfin/jellyfin --datadir D --configdir C --cachedir K --logdir L --webdir jellyfin/jellyfin-web
--ffmpeg /usr/bin/ffmpeg` with the plugin folder under `D/plugins/`. Complete the startup wizard with the
`/Startup/*` endpoints, add a music library of ffmpeg-generated FLAC files, then:

- `curl -s http://127.0.0.1:8096/web/index.html | grep data-jf-milkdrop` shows the injected tag.
- `curl -sI http://127.0.0.1:8096/Milkdrop/client.js?v=<version>` is 200 with `cache-control: public, max-age=31536000, immutable`.
- The server log has `Milkdrop: client script added to index.html at request time.` after the first page load.

## Release

1. Bump `version` (and `changelog`) in `meta.json`. Commit on `main` and push.
2. CI builds, tests, zips `Jellyfin.Plugin.Milkdrop.dll` + `meta.json`, creates release `v<version>` with
   the zip attached, and commits `manifest.json` (md5, download URL, timestamp) back to `main` with
   `[skip ci]`. A version that already has a release is skipped, so a push without a bump publishes nothing.
3. Jellyfin servers that added `.../raw/branch/main/manifest.json` as a repository pick it up.

The release step uses `secrets.RELEASE_TOKEN` when set, else the run's `GITHUB_TOKEN`.

## Behavior to preserve

- **Injection is request-time only.** Never write to jellyfin-web's folder: it is root-owned in the
  container and replaced on every image update.
- **The tag is not `defer`red.** jellyfin-web asks `NativeShell.getPlugins()` from its deferred bundles; the
  wrap that hides `mpvAudioPlayer` must already be in place, so the plugin's tag runs synchronously at the
  end of `<body>`.
- **The toggle button lives inside a positioned wrapper div.** jellyfin-web's focus manager treats
  `offsetParent === null` as "not focusable", and a `position: fixed` element's offsetParent is always
  null; a child of a fixed wrapper has the wrapper as offsetParent. Making the button itself fixed breaks
  D-pad navigation.
- **One Web Audio source per `<audio>` element**, kept in a WeakMap: `createMediaElementSource` throws on a
  second call for the same element, and jellyfin-web reuses one element across tracks but may replace it.
- **Hotkeys use `window` keydown in the capture phase** with `stopImmediatePropagation`, so `Escape` closes
  the visualizer instead of being jellyfin-web's "back".
- **Track changes do not close the visualizer:** the audio element is emptied and reloaded between tracks,
  so a stop only counts after a 1.5 s grace with nothing loaded.
- **Asset URLs carry `?v=<plugin version>`** and are served immutable for a year when the version matches,
  `no-cache` otherwise. The index.html ETag is the hash of the served bytes, so a settings change or a
  plugin update replaces a cached page.

## Lessons

- 2026-10-27: jellyfin-web 12.2's `htmlAudioPlayer` creates `<audio class="mediaPlayerAudio">` on the body
  and keeps it; `stop()` pauses and may remove it. Watching by selector plus a MutationObserver covers both.
- 2026-10-27: `NativeShell.getPlugins()` is concatenated synchronously into jellyfin-web's plugin list
  (`list.concat(window.NativeShell.getPlugins())`), each entry then `loadPlugin`ed. Filtering the array is
  enough; the wrap also handles a Promise in case a future shell returns one.
