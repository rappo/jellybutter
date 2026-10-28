# Milkdrop Visualizer for Jellyfin

A [Butterchurn](https://github.com/jberg/butterchurn) (MilkDrop 2, WebGL) music visualizer inside the
Jellyfin web client, and inside Jellyfin Desktop. One server plugin, installed once from a plugin
repository, updated from there; nothing to install on any client.

![The visualizer full screen in Jellyfin Desktop, with the preset controls at the bottom right](docs/visualizer.png)

## What it does

- A round **visualizer button** appears at the bottom right whenever a track is loaded in the web player.
  It is a real button, so jellyfin-web's arrow-key (D-pad) navigation reaches it.
- The visualizer opens **full screen**: a random preset to start, a new one every 30 seconds (setting),
  2.7 seconds of blend between presets (setting), and the preset's name shown for 3 seconds on each change.
- **Hotkeys:** `v` toggles the visualizer, `b` next preset, `n` previous preset, `Escape` closes. A Steam
  Input layout that maps paddles to `v`, `b` and `n` drives it from a controller. On-screen buttons for
  previous, random, next and close appear on hover or when focused.
- **Jellyfin Desktop:** the desktop client plays music through mpv, which a web page cannot hear. With the
  "Play music in the web player on Jellyfin Desktop" setting (on by default) the plugin hides the mpv
  audio player from the web client, so music plays through the web player and the visualizer hears it.
  Video stays on mpv. Audio output is unchanged: the web view plays to the system's default sink.
- **Self-contained:** the plugin serves the Butterchurn engine and presets itself. Nothing is loaded from
  a CDN, so it works on a LAN with no internet.

## Install

The one manual step: add the plugin repository to your server.

1. Dashboard > Plugins > Repositories > **+**
2. Name: `Milkdrop`, URL: `http://argos.lan.rappo.me:3210/rappo/jellyfin-plugin-milkdrop/raw/branch/main/manifest.json`
3. Dashboard > Plugins > Catalog > **Milkdrop Visualizer** > Install, then restart the server.

Jellyfin checks the repository for updates on its own schedule and installs them like any other plugin.

Requires Jellyfin 12.2 or later (target ABI 12.2.0.0).

## Settings

Dashboard > Plugins > Milkdrop Visualizer.

| Setting | Default | Meaning |
| --- | --- | --- |
| Add the visualizer to the web client | on | The master switch. Off, the web client is served untouched and the plugin's files answer 404. |
| Play music in the web player on Jellyfin Desktop | on | Hide mpv's audio player from the web client so music plays through the web player (video stays on mpv). |
| Change preset every (seconds) | 30 | 0 keeps a preset until you change it. |
| Blend between presets (seconds) | 2.7 | 0 switches instantly. |

Settings take effect on the next page load of the web client (a reload, or reopening the desktop client).

## How it works

Jellyfin gives plugins no hook into the web client, and `index.html` on disk is replaced by every server
update, so the plugin rewrites it **at request time**: an ASP.NET startup filter puts a middleware ahead
of the static-file handler that buffers only the `index.html` response and appends one `<script>` tag
before `</body>`. The tag carries the settings as JSON in a data attribute and loads the client script
from the plugin, with the plugin version as a cache buster. Everything else passes through untouched.

The client script (plain JavaScript) watches for jellyfin-web's `<audio>` element, routes it through a Web
Audio graph the first time the visualizer opens (an element's output can only be captured once, so the
graph is built once per element), and lazy-loads the two Butterchurn bundles from the plugin on that first
open. Butterchurn 2.6.7 and butterchurn-presets 2.4.7 are pinned in `package.json`, copied from
`node_modules` by the build and embedded in the DLL.

## Development

See [AGENTS.md](AGENTS.md) for the layout, build, tests, release and the lessons learned.

```bash
npm ci && npm test && dotnet test
```

## License

MIT. Butterchurn and butterchurn-presets are MIT, (c) Jordan Berg; the presets carry their authors' names.
