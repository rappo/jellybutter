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
  Configuration/PluginConfiguration.cs   Enabled, DesktopWebAudio, CycleSeconds, BlendSeconds, ControlButton,
                                   FloatingButton, DefaultView, LyricsSize
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

- Lyrics for the test tracks: an `.lrc` (synced) or `.txt` (plain) file next to a FLAC with the same base
  name, then `POST /Library/Refresh`; `GET /Audio/{id}/Lyrics` returns `{ Lyrics: [{ Text, Start? }] }`
  with `Start` in 100 ns ticks, or 404 when a track has none.
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
- **The Now Playing button goes into `.nowPlayingSecondaryButtons`**, right after `.btnLyrics` (else before
  `.btnShuffleQueue`, else last). jellyfin-web 12.2's Now Playing page has two groups: the transport
  controls in `.nowPlayingInfoButtons` (with a second shuffle/repeat pair for the mobile layout) and
  favorite, lyrics, shuffle, repeat and volume in `.nowPlayingSecondaryButtons`. The button is made as
  jellyfin-web makes its own (`createElement('button', { is: 'paper-icon-button-light' })` with a
  `material-icons graphic_eq` span), so it takes the row's size, focus ring and TV-layout focus scale.
  jellyfin-web rebuilds the row, so every DOM mutation and every `viewshow`/`viewhide` schedules a refresh
  (coalesced onto one animation frame: the refresh reads layout) that puts the button back and recomputes
  which button shows.
- **"The row is on screen" means `offsetParent !== null` and a width, not "in the DOM":** jellyfin-web
  keeps the Now Playing view in the DOM, hidden, after navigating away. The floating button shows exactly
  when the row is not on screen (or the row button is switched off); see `buttonPlacement`.
- **The floating toggle button lives inside a positioned wrapper div.** jellyfin-web's focus manager treats
  `offsetParent === null` as "not focusable", and a `position: fixed` element's offsetParent is always
  null; a child of a fixed wrapper has the wrapper as offsetParent. Making the button itself fixed breaks
  D-pad navigation.
- **jellyfin-web connects the `<audio>` element itself** (its audio player makes an AudioContext with a gain
  node for volume normalization as playback starts), and an element can feed only one
  MediaElementAudioSourceNode. The script wraps `AudioContext.prototype.createMediaElementSource` at load,
  before jellyfin-web's deferred bundles run, and records every element's context and source node in a
  WeakMap; Butterchurn is created in that same context and connected to that node. An element nobody
  connected gets a context of the script's own. There is no separate analyser: Butterchurn brings its own.
- **Jellyfin Desktop needs two wraps, not one.** Besides dropping `mpvAudioPlayer` from
  `NativeShell.getPlugins()`, `NativeShell.AppHost.getDeviceProfile` is wrapped: the shell's profile
  describes mpv and its audio transcoding entry has no Container or Context, and jellyfin-web's
  universal-audio URL builder throws on it ("Playback Error" with no request reaching the server). The
  audio-typed DirectPlay, Transcoding and Codec profiles are replaced by the browser's own, obtained from the
  profile builder jellyfin-web passes as the first argument (`mergeAudioProfile`).
- **Butterchurn's `width`/`height` are the canvas buffer in device pixels** (its last pass sets the viewport
  to exactly that), so the buffer is sized to the viewport times `devicePixelRatio` and those numbers are
  passed with `pixelRatio: 1`. Passing CSS pixels with `pixelRatio: devicePixelRatio` draws only the
  bottom-left part of the canvas on a scaled display (seen at 1.4x in Jellyfin Desktop).
- **Assets are cached immutable for a year under `?v=<version>`**, so during development a browser keeps
  the old script until the version changes: use a fresh origin (127.0.0.2, 127.0.0.3, ...) per build, or a
  devtools reload that bypasses the cache (`Page.reload` with `ignoreCache`; QtWebEngine ignores
  `Network.clearBrowserCache` for these). A release never has this problem: CI refuses to republish a version.
- **Lyrics come from Jellyfin's Lyrics API through jellyfin-web's own `window.ApiClient`** (`getJSON` of
  `getUrl('Audio/' + id + '/Lyrics')`, which carries the session's auth), once per track, keyed by the
  item id parsed out of the `<audio>` element's URL (`Audio/{id}/universal`, `Audio/{id}/stream.*`).
  `Start` is in 100 ns ticks; `normalizeLyrics` turns it into seconds and sorts. Lyrics are synced only
  when every line has a time. The current line is picked by the element's `currentTime` on every rendered
  frame (`lyricIndexAt`), classes and the column's transform change only when the index changes; an
  unsynced block is centered when it fits and translated by playback progress when taller than the view
  (`blockOffset`). Readability over any preset comes from the text stroke under the fill
  (`paint-order: stroke fill`), the drop shadow and the accent glow on the current line; the column fades
  at the top and bottom edges with a mask.
- **The opening view is the setting, every time:** `open()` sets lyrics on or off from
  `config.defaultView`; `l` and the Lyrics control toggle it for the rest of that session of the overlay.
- **`window.jfMilkdrop`** is a read-only diagnostic handle (version, config, core helpers, live state) for a
  devtools session on a client in the field.
- **Hotkeys use `window` keydown in the capture phase** with `stopImmediatePropagation`, so `Escape` closes
  the visualizer instead of being jellyfin-web's "back".
- **Track changes do not close the visualizer:** the audio element is emptied and reloaded between tracks,
  so a stop only counts after a 1.5 s grace with nothing loaded.
- **Asset URLs carry `?v=<plugin version>`** and are served immutable for a year when the version matches,
  `no-cache` otherwise. The index.html ETag is the hash of the served bytes, so a settings change or a
  plugin update replaces a cached page.

## Lessons

- 2026-10-27: In the TV layout, jellyfin-web's D-pad choice is geometry over the focused element's
  *scaled* box (`.show-focus:focus` scales it), and at a 1280x720 window the volume's mute button wraps
  to a second line right under the Lyrics button. Right from Lyrics then sometimes lands on mute instead
  of the next button in the row, with or without the plugin's button; once the scale animation settles,
  right from Lyrics reaches the visualizer button and left from Shuffle does too. Not something the plugin
  can fix; probe D-pad paths with a short wait after moving focus.
- 2026-10-27: When restarting the throwaway server and reloading the client in one go, wait for the
  plugin endpoint to answer before `Page.reload`: a reload that races the restart gets no new script and
  the immutable cached one stays.

- 2026-10-27: Jellyfin Desktop can be driven headlessly for verification: `flatpak run
  org.jellyfin.JellyfinDesktop --create-profile <name>`, then `--profile <name> --remote-debugging-port 9222
  --windowed --log-level debug`; a second instance on its own profile leaves the user's running one alone.
  The profile's log is under `~/.var/app/org.jellyfin.JellyfinDesktop/data/jellyfin-desktop/profiles/<id>/logs/`
  and forwards the page's console. Confirmed there: `NativeShell.getPlugins()` loses `mpvAudioPlayer`, an
  `<audio>` element plays the track, the toggle appears, WebGL 2 renders full screen, v/b/n/Escape work.
- 2026-10-27: The desktop app's built-in browser pane has no WebGL at all and the laptop's audio sink was
  `auto_null`, so neither rendering nor audible output can be verified there; Chromium stalls a media
  element routed through Web Audio when the audio device fails ("The AudioContext encountered an error
  from the audio device"). Not a plugin fault: mpv in the same session logged `ao/pulse: Init failed`.

- 2026-10-27: jellyfin-web 12.2's `htmlAudioPlayer` creates `<audio class="mediaPlayerAudio">` on the body
  and keeps it; `stop()` pauses and may remove it. Watching by selector plus a MutationObserver covers both.
- 2026-10-27: `NativeShell.getPlugins()` is concatenated synchronously into jellyfin-web's plugin list
  (`list.concat(window.NativeShell.getPlugins())`), each entry then `loadPlugin`ed. Filtering the array is
  enough; the wrap also handles a Promise in case a future shell returns one.
