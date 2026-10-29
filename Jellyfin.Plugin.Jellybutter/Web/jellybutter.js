/*
 * Jellybutter Visualizer for Jellyfin: a Butterchurn (MilkDrop 2, WebGL) visualizer for jellyfin-web.
 *
 * Loaded by the script tag the plugin adds to index.html. Plain JavaScript, no framework, no build step.
 * The tag's data-config attribute carries the plugin settings as JSON. The script:
 *
 *   - On Jellyfin Desktop, wraps NativeShell.getPlugins so music plays through the web player (an <audio>
 *     element Web Audio can hear) instead of mpv, when the setting says so. Video stays on mpv. This runs
 *     synchronously at load, before jellyfin-web's deferred bundles ask the shell for its plugins.
 *   - Watches for jellyfin-web's <audio> element and offers a visualizer button while a track is loaded:
 *     in the Now Playing control row (between Lyrics and Shuffle, built like jellyfin-web's own icon
 *     buttons) when that row is on screen, and a floating button elsewhere. jellyfin-web rebuilds the
 *     row, so the button is put back whenever it goes missing. The floating button sits inside a
 *     positioned wrapper because jellyfin-web's arrow-key (D-pad) focus manager skips any element whose
 *     offsetParent is null, which a fixed-position element's always is.
 *   - Listens on the element's Web Audio source node. jellyfin-web's own audio player routes the element
 *     through an AudioContext of its own (a gain node for volume normalization) as playback starts, and an
 *     element can feed only one MediaElementAudioSourceNode, so createMediaElementSource is wrapped at
 *     load to capture the context and node whichever side connects first; an element nobody connected
 *     gets a context of the script's own. On first open it lazy-loads the two Butterchurn bundles from the
 *     plugin, then renders full screen with a random starting preset, auto-cycling, blended changes and
 *     a preset-name flash.
 *   - Lyrics view: the track's lyrics from Jellyfin's Lyrics API over the visualizer. Synced lyrics follow
 *     the audio element's clock with the current line large and glowing; unsynced lyrics sit as a block,
 *     centered when they fit and scrolled with playback progress when they do not.
 *   - Now Playing bar: jellyfin-web's own bar along the bottom of the visualizer, live, on every page. jellyfin-web
 *     shows it only on views whose options allow media control, read from the viewbeforeshow event on the
 *     document; opening tells it "allowed" with that same event and closing hands back the page's own value.
 *   - Hotkeys: v toggles the visualizer, l toggles lyrics, b next preset, n previous preset, Escape closes.
 *     Ignored while typing in a field.
 *
 * The pure helpers live on JellybutterCore and are exported for the node:test suite under tests/; the DOM
 * part only runs in a browser.
 */
(function () {
    'use strict';

    var DEFAULTS = {
        desktopWebAudio: true,
        cycleSeconds: 30,
        blendSeconds: 2.7,
        controlButton: true,
        floatingButton: true,
        nowPlayingBar: true,
        defaultView: 'visualizer',
        lyricsSize: 'medium'
    };
    var VIEWS = ['visualizer', 'lyrics'];
    var LYRICS_SIZES = ['small', 'medium', 'large'];
    var NAME_FLASH_MS = 3000;
    var STOP_GRACE_MS = 1500;
    var TICKS_PER_SECOND = 10000000;

    function pickOne(value, allowed, fallback) {
        var v = typeof value === 'string' ? value.toLowerCase() : '';
        return allowed.indexOf(v) >= 0 ? v : fallback;
    }

    var JellybutterCore = {
        /**
         * Parses the data-config JSON, filling in a default for anything missing or malformed, so a tag
         * from an older or newer plugin version still yields usable settings.
         */
        parseConfig: function (text) {
            var parsed = null;
            if (typeof text === 'string' && text) {
                try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
            }
            if (!parsed || typeof parsed !== 'object') { parsed = {}; }
            var cycle = Number(parsed.cycleSeconds);
            var blend = Number(parsed.blendSeconds);
            var flag = function (name) { return typeof parsed[name] === 'boolean' ? parsed[name] : DEFAULTS[name]; };
            return {
                desktopWebAudio: flag('desktopWebAudio'),
                cycleSeconds: isFinite(cycle) && cycle >= 0 ? cycle : DEFAULTS.cycleSeconds,
                blendSeconds: isFinite(blend) && blend >= 0 ? blend : DEFAULTS.blendSeconds,
                controlButton: flag('controlButton'),
                floatingButton: flag('floatingButton'),
                nowPlayingBar: flag('nowPlayingBar'),
                defaultView: pickOne(parsed.defaultView, VIEWS, DEFAULTS.defaultView),
                lyricsSize: pickOne(parsed.lyricsSize, LYRICS_SIZES, DEFAULTS.lyricsSize)
            };
        },

        /**
         * The Jellyfin Desktop player-list filter: drops the mpv audio player so jellyfin-web's own
         * htmlAudioPlayer (the next by priority) plays music through an <audio> element. Anything that is
         * not a list, and the video player, pass through untouched; an entry is matched by name wherever it
         * appears in the string, so a module path would match too.
         */
        filterNativePlugins: function (plugins, config) {
            if (!config || !config.desktopWebAudio || !Array.isArray(plugins)) { return plugins; }
            return plugins.filter(function (p) {
                return typeof p !== 'string' || p.indexOf('mpvAudioPlayer') < 0;
            });
        },

        /**
         * The Jellyfin Desktop device-profile fix-up. The shell's profile describes mpv (every container,
         * an audio transcoding entry with no container or context), which is wrong for the web player on
         * two counts: jellyfin-web's universal-audio URL builder dereferences the first audio "Streaming"
         * transcoding profile and throws when there is none, and the web view cannot decode everything
         * mpv can. The audio entries (DirectPlay, Transcoding and Codec profiles of type Audio) are taken
         * from the browser's own profile instead; video, photo and everything else stay the shell's. A
         * missing browser profile leaves the shell's untouched.
         */
        mergeAudioProfile: function (shellProfile, browserProfile) {
            if (!shellProfile || typeof shellProfile !== 'object' || !browserProfile || typeof browserProfile !== 'object') { return shellProfile; }
            var isAudio = function (p) { return p && p.Type === 'Audio'; };
            var notAudio = function (p) { return !isAudio(p); };
            var merged = {};
            Object.keys(shellProfile).forEach(function (k) { merged[k] = shellProfile[k]; });
            ['DirectPlayProfiles', 'TranscodingProfiles', 'CodecProfiles'].forEach(function (key) {
                var shell = Array.isArray(shellProfile[key]) ? shellProfile[key] : [];
                var browser = Array.isArray(browserProfile[key]) ? browserProfile[key] : [];
                merged[key] = shell.filter(notAudio).concat(browser.filter(isAudio));
            });
            return merged;
        },

        /** Wraps an index around the preset list. */
        stepIndex: function (index, count, delta) {
            if (!count) { return 0; }
            return ((index + delta) % count + count) % count;
        },

        /** A random index, different from the current one when there is a choice. */
        randomIndex: function (count, current, random) {
            if (!count) { return 0; }
            var r = typeof random === 'function' ? random : Math.random;
            if (count === 1) { return 0; }
            if (!(current >= 0 && current < count)) { return Math.floor(r() * count); }
            var pick = Math.floor(r() * (count - 1));
            return pick >= current ? pick + 1 : pick;
        },

        /** Whether a key event's target is a place where typing happens, so hotkeys stay out of the way. */
        isTypingTarget: function (tagName, isContentEditable) {
            var tag = (tagName || '').toUpperCase();
            return isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        },

        /**
         * Maps a key to an action given the current state: 'toggle', 'lyrics', 'next', 'prev', 'close' or
         * null. The toggle only works while a track is loaded (there is nothing to visualize otherwise);
         * the others only while the visualizer is open. Modifier combinations are left to the browser.
         */
        hotkeyFor: function (key, open, trackLoaded, modifiers) {
            if (modifiers && (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey)) { return null; }
            var k = (key || '').toLowerCase();
            if (k === 'v') { return open || trackLoaded ? 'toggle' : null; }
            if (!open) { return null; }
            if (k === 'escape') { return 'close'; }
            if (k === 'b') { return 'next'; }
            if (k === 'n') { return 'prev'; }
            if (k === 'l') { return 'lyrics'; }
            return null;
        },

        /**
         * Whether an <audio> element has a track to visualize: playing, or paused on a loaded track. A
         * stopped element (source cleared) or one that has ended does not count.
         */
        isTrackLoaded: function (audio) {
            if (!audio) { return false; }
            if (audio.ended) { return false; }
            if (!audio.paused) { return true; }
            return !!audio.currentSrc && audio.readyState >= 1;
        },

        /**
         * Which buttons to show. The control-row button needs the Now Playing row on screen; the floating
         * button covers every other page, and the Now Playing page too when the row button is switched
         * off. Neither shows without a track, or once the browser proved it cannot render.
         */
        buttonPlacement: function (config, trackLoaded, unsupported, rowVisible) {
            var can = !!trackLoaded && !unsupported && !!config;
            var control = can && config.controlButton && !!rowVisible;
            var floating = can && config.floatingButton && !(rowVisible && config.controlButton);
            return { control: control, floating: floating };
        },

        /**
         * Where the control-row button goes among the row's children, given their class strings: right
         * after jellyfin-web's Lyrics button, else before its first Shuffle button, else at the end.
         */
        controlButtonIndex: function (classNames) {
            var list = Array.isArray(classNames) ? classNames : [];
            var has = function (classes, name) { return (' ' + (classes || '') + ' ').indexOf(' ' + name + ' ') >= 0; };
            for (var i = 0; i < list.length; i++) {
                if (has(list[i], 'btnLyrics')) { return i + 1; }
            }
            for (var j = 0; j < list.length; j++) {
                if (has(list[j], 'btnShuffleQueue')) { return j; }
            }
            return list.length;
        },

        /**
         * The enableMediaControl value jellyfin-web's Now Playing bar should be given: allowed while the
         * visualizer is open with the bar setting on, else whatever the current page allows (unknown counts
         * as allowed, jellyfin-web's own starting value).
         */
        mediaControlFor: function (open, barSetting, pageAllows) {
            return open && barSetting ? true : pageAllows !== false;
        },

        /**
         * How much of the bottom of the visualizer the Now Playing bar covers, in pixels: its footer's height
         * while the bar is shown, nothing while it is missing, hidden (`hide`) or slid away
         * (`nowPlayingBar-hidden`).
         */
        barInset: function (barClassName, footerHeight) {
            if (typeof barClassName !== 'string') { return 0; }
            var classes = ' ' + barClassName + ' ';
            if (classes.indexOf(' hide ') >= 0 || classes.indexOf(' nowPlayingBar-hidden ') >= 0) { return 0; }
            return footerHeight > 0 ? Math.round(footerHeight) : 0;
        },

        /** The item id in a jellyfin-web audio URL (Audio/{id}/universal, Audio/{id}/stream.flac, ...). */
        itemIdFromSrc: function (src) {
            if (typeof src !== 'string') { return null; }
            var m = /\/Audio\/([0-9a-fA-F]{32}|[0-9a-fA-F-]{36})(?=[/?#]|$)/.exec(src);
            return m ? m[1].replace(/-/g, '').toLowerCase() : null;
        },

        /**
         * Turns a Lyrics API response ({ Lyrics: [{ Text, Start? }] }, Start in 100 ns ticks) into
         * { synced, lines: [{ start (seconds) | null, text }] }, lines sorted by time when synced. Lyrics
         * count as synced only when every line carries a time. Null when there are no lines with text.
         */
        normalizeLyrics: function (dto) {
            var raw = dto && Array.isArray(dto.Lyrics) ? dto.Lyrics : [];
            var lines = raw.filter(function (l) { return l && typeof l === 'object'; }).map(function (l) {
                var start = Number(l.Start);
                return { start: l.Start !== undefined && l.Start !== null && isFinite(start) ? start / TICKS_PER_SECOND : null, text: String(l.Text === undefined || l.Text === null ? '' : l.Text).trim() };
            });
            if (!lines.some(function (l) { return l.text; })) { return null; }
            var synced = lines.every(function (l) { return l.start !== null; });
            if (synced) {
                lines = lines.map(function (l, i) { return { start: l.start, text: l.text, order: i }; })
                    .sort(function (a, b) { return a.start - b.start || a.order - b.order; })
                    .map(function (l) { return { start: l.start, text: l.text }; });
            } else {
                lines = lines.map(function (l) { return { start: null, text: l.text }; });
            }
            return { synced: synced, lines: lines };
        },

        /** The index of the synced line playing at a time: the last one that has started, -1 before the first. */
        lyricIndexAt: function (lines, seconds) {
            if (!Array.isArray(lines) || !isFinite(seconds)) { return -1; }
            var index = -1;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].start <= seconds) { index = i; } else { break; }
            }
            return index;
        },

        /**
         * The vertical offset of an unsynced lyrics block: none while it fits its viewport (CSS centers
         * it), else scrolled with playback progress so the end of the block arrives with the end of the
         * track.
         */
        blockOffset: function (blockHeight, viewHeight, progress) {
            if (!(blockHeight > viewHeight)) { return 0; }
            var p = isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
            return -Math.round((blockHeight - viewHeight) * p) || 0;
        },

        /** The plugin folder the client script was served from, so the bundles resolve beside it. */
        assetBase: function (scriptSrc) {
            if (typeof scriptSrc !== 'string') { return null; }
            var withoutQuery = scriptSrc.split('?')[0];
            var slash = withoutQuery.lastIndexOf('/');
            return slash < 0 ? null : withoutQuery.slice(0, slash + 1);
        },

        /** A bundle URL carrying the same version query as the script tag, for the same cache behavior. */
        assetUrl: function (base, name, version) {
            return base + name + '?v=' + encodeURIComponent(version || '');
        }
    };

    if (typeof module === 'object' && module && module.exports) {
        module.exports = JellybutterCore;
    }
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }

    // ---- Runtime ----------------------------------------------------------------------------------------

    var scriptEl = document.currentScript;
    var config = JellybutterCore.parseConfig(scriptEl && scriptEl.getAttribute('data-config'));
    var scriptSrc = scriptEl && scriptEl.src;
    var version = (function () {
        var m = /[?&]v=([^&]*)/.exec(scriptSrc || '');
        return m ? decodeURIComponent(m[1]) : '';
    })();
    var assetBase = JellybutterCore.assetBase(scriptSrc) || 'Jellybutter/';

    // Jellyfin Desktop: must run now, before jellyfin-web's deferred bundles load its plugins and ask for
    // the device profile. Two wraps: the plugin list loses the mpv audio player, and the device profile
    // gets the browser's audio entries (jellyfin-web hands the shell its own profile builder as the
    // first argument, which is how the browser's profile is obtained here).
    (function patchNativeShell() {
        var shell = window.NativeShell;
        if (!shell || typeof shell.getPlugins !== 'function' || shell.__jellybutterWrapped || !config.desktopWebAudio) { return; }
        var originalPlugins = shell.getPlugins;
        shell.getPlugins = function () {
            var list = originalPlugins.apply(this, arguments);
            if (list && typeof list.then === 'function') {
                return list.then(function (resolved) { return JellybutterCore.filterNativePlugins(resolved, config); });
            }
            return JellybutterCore.filterNativePlugins(list, config);
        };
        var host = shell.AppHost;
        if (host && typeof host.getDeviceProfile === 'function') {
            var originalProfile = host.getDeviceProfile;
            host.getDeviceProfile = function (profileBuilder) {
                var result = originalProfile.apply(this, arguments);
                var browser = null;
                try { browser = typeof profileBuilder === 'function' ? profileBuilder({}) : null; } catch (e) { browser = null; }
                var merge = function (profile) { return JellybutterCore.mergeAudioProfile(profile, browser); };
                return result && typeof result.then === 'function' ? result.then(merge) : merge(result);
            };
        }
        shell.__jellybutterWrapped = true;
        console.info('[Jellybutter] Jellyfin Desktop: music will play through the web player so the visualizer can hear it.');
    })();

    var state = {
        audio: null,            // the <audio> element being watched
        trackLoaded: false,     // isTrackLoaded(audio), held through the between-tracks gap
        tap: null,              // { context, source } of state.audio, see taps
        ownContext: null,       // the AudioContext for elements nobody else connected
        engine: null,           // the butterchurn API once loaded
        visualizer: null,
        visualizerContext: null,
        presets: null,          // { [name]: preset }
        names: [],              // sorted preset names
        index: 0,
        open: false,
        lyricsOn: false,
        lyrics: { itemId: null, data: null, index: -2, offset: null, elements: [] },
        raf: 0,
        cycleTimer: 0,
        flashTimer: 0,
        stopTimer: 0,
        libs: null,             // Promise for the bundles
        unsupported: false,     // set once the browser proved it has no WebGL 2
        lastFocus: null,
        pageMediaControl: null, // enableMediaControl of the page jellyfin-web last showed; null until one shows
        barObserver: null       // watches the Now Playing bar while the visualizer shows it
    };

    var ui = {};

    function css() {
        var style = document.createElement('style');
        style.id = 'jellybutter-style';
        style.textContent = [
            '.jellybutter-toggle-wrap{position:fixed;right:1.5em;bottom:6.5em;z-index:9998;display:none}',
            '.jellybutter-toggle-wrap.jellybutter-visible{display:block}',
            '.jellybutter-toggle{width:3em;height:3em;border-radius:50%;border:none;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 .15em .8em rgba(0,0,0,.5);transition:background .2s,transform .15s;padding:0}',
            '.jellybutter-toggle:hover,.jellybutter-toggle:focus{background:rgba(0,164,220,.85);outline:none;transform:scale(1.1)}',
            '.jellybutter-toggle:focus-visible{box-shadow:0 0 0 .2em #fff}',
            '.jellybutter-toggle svg{width:1.5em;height:1.5em}',
            '.jellybutter-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none;font-family:inherit}',
            '.jellybutter-overlay.jellybutter-open{display:block}',
            '.jellybutter-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
            '.jellybutter-toast{position:absolute;top:1em;left:1em;padding:.5em .9em;background:rgba(0,0,0,.55);color:#fff;border-radius:.5em;font:600 .95em/1.3 sans-serif;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .3s}',
            '.jellybutter-toast.jellybutter-shown{opacity:1}',
            '.jellybutter-toast small{display:block;font-weight:400;font-size:.75em;color:rgba(255,255,255,.55)}',
            '.jellybutter-controls{position:absolute;right:1em;bottom:calc(1em + var(--jellybutter-bar,0px));display:flex;gap:.3em;opacity:0;transition:opacity .3s}',
            '.jellybutter-overlay:hover .jellybutter-controls,.jellybutter-controls:focus-within,.jellybutter-overlay.jellybutter-controls-shown .jellybutter-controls{opacity:1}',
            '.jellybutter-ctrl{width:2.4em;height:2.4em;border:none;border-radius:50%;background:rgba(0,0,0,.5);color:rgba(255,255,255,.85);font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
            '.jellybutter-ctrl:hover,.jellybutter-ctrl:focus{background:rgba(0,164,220,.85);color:#fff;outline:none}',
            '.jellybutter-ctrl:focus-visible{box-shadow:0 0 0 .2em #fff}',
            '.jellybutter-ctrl[aria-pressed="true"]{background:rgba(0,164,220,.55);color:#fff}',
            '.jellybutter-ctrl svg{width:1.2em;height:1.2em}',
            // Lyrics layer: a column over the canvas, faded at the top and bottom edges, never catching
            // the pointer. Sizes are em of the overlay so the TV layout's larger root font scales them.
            '.jellybutter-lyrics{position:absolute;inset:0 0 var(--jellybutter-bar,0px) 0;display:none;overflow:hidden;pointer-events:none;text-align:center;' +
                '-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 12%,#000 88%,transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 12%,#000 88%,transparent 100%)}',
            '.jellybutter-overlay.jellybutter-lyrics-on .jellybutter-lyrics{display:block}',
            '.jellybutter-lyrics-small{--jellybutter-line:1.25em;--jellybutter-active:1.9em}',
            '.jellybutter-lyrics-medium{--jellybutter-line:1.6em;--jellybutter-active:2.5em}',
            '.jellybutter-lyrics-large{--jellybutter-line:2em;--jellybutter-active:3.2em}',
            '.jellybutter-lyrics-scroll{position:absolute;left:8vw;right:8vw;top:0;will-change:transform}',
            '.jellybutter-lyrics-synced .jellybutter-lyrics-scroll{transition:transform .5s cubic-bezier(.2,.7,.2,1)}',
            '.jellybutter-lyrics-block{position:absolute;left:8vw;right:8vw;top:50%;transform:translateY(-50%)}',
            '.jellybutter-lyrics-block.jellybutter-lyrics-tall{top:0;transform:none;padding:12vh 0}',
            // Readable over any preset: a dark stroke under the fill, a dark drop shadow, and on the
            // current line the accent glow.
            '.jellybutter-lyric{margin:0;padding:.18em 0;color:rgba(255,255,255,.92);font-size:var(--jellybutter-line);font-weight:500;line-height:1.3;' +
                '-webkit-text-stroke:2px rgba(0,0,0,.75);paint-order:stroke fill;text-shadow:0 2px 4px rgba(0,0,0,.9);' +
                'transition:color .4s,font-size .4s,text-shadow .4s,opacity .4s;min-height:1.3em}',
            '.jellybutter-lyric-past{opacity:.6;color:rgba(255,255,255,.8)}',
            '.jellybutter-lyric-future{opacity:.8}',
            '.jellybutter-lyric-active{opacity:1;color:#fff;font-size:var(--jellybutter-active);font-weight:700;-webkit-text-stroke:2px rgba(0,0,0,.8);' +
                'text-shadow:0 0 20px rgba(0,164,220,.5),0 0 40px rgba(0,164,220,.25),0 2px 4px rgba(0,0,0,.9)}',
            '.jellybutter-lyric-note{position:absolute;left:8vw;right:8vw;top:50%;transform:translateY(-50%);opacity:.8;font-style:italic}',
            // jellyfin-web's footer (it holds the Now Playing bar) above the overlay, and pinned: its headroom
            // otherwise slides it away on scroll. Its own rule is z-index:1201!important.
            'html.jellybutter-bar .appfooter{z-index:100000!important;transform:none!important}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function icon(path) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
    }

    var ICONS = {
        bars: '<line x1="4" y1="12" x2="4" y2="20"/><line x1="8" y1="5" x2="8" y2="20"/><line x1="12" y1="2" x2="12" y2="20"/><line x1="16" y1="8" x2="16" y2="20"/><line x1="20" y1="14" x2="20" y2="20"/>',
        prev: '<polyline points="15 18 9 12 15 6"/>',
        next: '<polyline points="9 18 15 12 9 6"/>',
        random: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
        lyrics: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="16" y2="11"/><line x1="4" y1="16" x2="18" y2="16"/><line x1="4" y1="21" x2="12" y2="21"/>',
        close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
    };

    function button(className, label, svg, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = className;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = icon(svg);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
        return b;
    }

    function buildUi() {
        css();

        ui.toggleWrap = document.createElement('div');
        ui.toggleWrap.className = 'jellybutter-toggle-wrap';
        ui.toggle = button('jellybutter-toggle', 'Visualizer (v)', ICONS.bars, toggle);
        ui.toggle.setAttribute('aria-pressed', 'false');
        ui.toggleWrap.appendChild(ui.toggle);
        document.body.appendChild(ui.toggleWrap);

        ui.overlay = document.createElement('div');
        ui.overlay.className = 'jellybutter-overlay jellybutter-lyrics-' + config.lyricsSize;
        ui.overlay.setAttribute('role', 'dialog');
        ui.overlay.setAttribute('aria-label', 'Music visualizer');
        ui.canvas = document.createElement('canvas');
        ui.canvas.className = 'jellybutter-canvas';
        ui.lyrics = document.createElement('div');
        ui.lyrics.className = 'jellybutter-lyrics';
        ui.lyrics.setAttribute('aria-live', 'off');
        ui.toast = document.createElement('div');
        ui.toast.className = 'jellybutter-toast';
        ui.toast.setAttribute('aria-live', 'polite');
        ui.controls = document.createElement('div');
        ui.controls.className = 'jellybutter-controls';
        ui.prev = button('jellybutter-ctrl', 'Previous preset (n)', ICONS.prev, function () { loadPreset(JellybutterCore.stepIndex(state.index, state.names.length, -1)); });
        ui.random = button('jellybutter-ctrl', 'Random preset', ICONS.random, function () { loadPreset(JellybutterCore.randomIndex(state.names.length, state.index)); });
        ui.next = button('jellybutter-ctrl', 'Next preset (b)', ICONS.next, function () { loadPreset(JellybutterCore.stepIndex(state.index, state.names.length, 1)); });
        ui.lyricsBtn = button('jellybutter-ctrl', 'Lyrics (l)', ICONS.lyrics, function () { setLyrics(!state.lyricsOn); });
        ui.lyricsBtn.setAttribute('aria-pressed', 'false');
        ui.close = button('jellybutter-ctrl', 'Close visualizer (Escape)', ICONS.close, close);
        ui.controls.appendChild(ui.prev);
        ui.controls.appendChild(ui.random);
        ui.controls.appendChild(ui.next);
        ui.controls.appendChild(ui.lyricsBtn);
        ui.controls.appendChild(ui.close);
        ui.overlay.appendChild(ui.canvas);
        ui.overlay.appendChild(ui.lyrics);
        ui.overlay.appendChild(ui.toast);
        ui.overlay.appendChild(ui.controls);
        ui.canvas.addEventListener('click', function () { showControls(); });
        ui.overlay.addEventListener('mousemove', showControls);
        document.body.appendChild(ui.overlay);

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', resize);
    }

    var controlsTimer = 0;
    function showControls() {
        ui.overlay.classList.add('jellybutter-controls-shown');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(function () { ui.overlay.classList.remove('jellybutter-controls-shown'); }, 2500);
    }

    // ---- The Now Playing control-row button -------------------------------------------------------------

    // jellyfin-web 12.2's Now Playing page has two button groups: the transport controls
    // (.nowPlayingInfoButtons) and, at the right, favorite, lyrics, shuffle and repeat
    // (.nowPlayingSecondaryButtons). The button belongs in the second; the first is the fallback for a
    // layout without it.
    function findControlRow() {
        return document.querySelector('.nowPlayingSecondaryButtons') || document.querySelector('.nowPlayingInfoButtons');
    }

    function isOnScreen(el) {
        return !!el && el.offsetParent !== null && el.offsetWidth > 0;
    }

    /** jellyfin-web's own icon button, as the row's other buttons are made (a customized built-in). */
    function createControlButton() {
        var b;
        try { b = document.createElement('button', { is: 'paper-icon-button-light' }); } catch (e) { b = document.createElement('button'); }
        b.setAttribute('is', 'paper-icon-button-light');
        b.type = 'button';
        b.className = 'btnJellybutter autoSize hide';
        b.title = 'Visualizer';
        b.setAttribute('aria-label', 'Visualizer');
        b.setAttribute('aria-pressed', 'false');
        var glyph = document.createElement('span');
        glyph.className = 'material-icons graphic_eq';
        glyph.setAttribute('aria-hidden', 'true');
        b.appendChild(glyph);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
        return b;
    }

    /** Puts the button into the row if the row is there and the button is not: jellyfin-web rebuilds the row. */
    function ensureControlButton(row) {
        if (!row || !config.controlButton) { return null; }
        var existing = row.querySelector('.btnJellybutter');
        if (existing) { return existing; }
        var b = createControlButton();
        var index = JellybutterCore.controlButtonIndex(Array.prototype.map.call(row.children, function (c) { return c.className; }));
        row.insertBefore(b, row.children[index] || null);
        return b;
    }

    // Coalesced onto the next frame: the observer fires on every DOM change jellyfin-web makes, and a
    // refresh reads layout (is the row on screen?), which must not happen per mutation.
    var refreshPending = 0;
    function scheduleRefresh() {
        if (refreshPending) { return; }
        refreshPending = requestAnimationFrame(function () {
            refreshPending = 0;
            refreshButtons();
        });
    }

    function refreshButtons() {
        var row = findControlRow();
        var control = ensureControlButton(row);
        var placement = JellybutterCore.buttonPlacement(config, state.trackLoaded, state.unsupported, isOnScreen(row));
        if (control) {
            control.classList.toggle('hide', !placement.control);
            control.setAttribute('aria-pressed', state.open ? 'true' : 'false');
        }
        ui.toggleWrap.classList.toggle('jellybutter-visible', placement.floating);
    }

    // ---- Audio element watching --------------------------------------------------------------------------

    function findAudio() {
        return document.querySelector('audio.mediaPlayerAudio') || document.querySelector('audio');
    }

    var audioEvents = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'abort'];

    function watch(audio) {
        if (state.audio === audio) { return; }
        if (state.audio) {
            audioEvents.forEach(function (ev) { state.audio.removeEventListener(ev, onAudioEvent); });
        }
        state.audio = audio;
        state.tap = null;
        if (audio) {
            audioEvents.forEach(function (ev) { audio.addEventListener(ev, onAudioEvent); });
            if (state.open) { connect(); }
        }
        onAudioEvent();
    }

    function onAudioEvent() {
        var loaded = JellybutterCore.isTrackLoaded(state.audio);
        if (loaded) {
            clearTimeout(state.stopTimer);
            state.stopTimer = 0;
            state.trackLoaded = true;
            refreshButtons();
            if (state.open && state.lyricsOn) { loadLyrics(); }
            return;
        }
        // Between tracks jellyfin-web empties and reloads the same element within a moment; only a stop that
        // lasts closes the visualizer and hides the buttons.
        if (!state.stopTimer) {
            state.stopTimer = setTimeout(function () {
                state.stopTimer = 0;
                if (JellybutterCore.isTrackLoaded(state.audio)) { return; }
                state.trackLoaded = false;
                refreshButtons();
                if (state.open) { close(); }
            }, STOP_GRACE_MS);
        }
    }

    function startObserver() {
        watch(findAudio());
        var observer = new MutationObserver(function () {
            var audio = findAudio();
            if (audio !== state.audio) { watch(audio); }
            scheduleRefresh();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // jellyfin-web announces page changes on the document; the row's visibility follows them.
        ['viewshow', 'viewhide', 'viewbeforehide'].forEach(function (ev) {
            document.addEventListener(ev, scheduleRefresh, true);
        });
        document.addEventListener('viewbeforeshow', onViewBeforeShow, true);
    }

    // ---- Web Audio ----------------------------------------------------------------------------------------

    // HTMLMediaElement -> { context, source }: every MediaElementAudioSourceNode made on this page, by
    // jellyfin-web or by this script. Recorded by the wrap below, which is installed now, before
    // jellyfin-web's deferred bundles run, so its audio player's own connection is seen too.
    var taps = new WeakMap();

    (function captureSources() {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        var proto = Ctor && Ctor.prototype;
        if (!proto || typeof proto.createMediaElementSource !== 'function') { return; }
        var original = proto.createMediaElementSource;
        proto.createMediaElementSource = function (element) {
            var node = original.apply(this, arguments);
            if (element && typeof element === 'object') { taps.set(element, { context: this, source: node }); }
            return node;
        };
    })();

    function noop() { /* nothing */ }

    /** Finds or makes the source node of the current element and points the visualizer at it. */
    function connect() {
        var audio = state.audio;
        if (!audio) { return null; }
        var tap = taps.get(audio);
        if (!tap) {
            // Nobody connected this element (normalization off, or a replaced element): route it through a
            // context of our own, to the speakers as before. The wrap records it.
            if (!state.ownContext) {
                var Ctor = window.AudioContext || window.webkitAudioContext;
                state.ownContext = new Ctor();
            }
            var source = state.ownContext.createMediaElementSource(audio);
            source.connect(state.ownContext.destination);
            tap = taps.get(audio) || { context: state.ownContext, source: source };
            taps.set(audio, tap);
        }
        if (tap.context.state === 'suspended') {
            tap.context.resume().catch(noop);
        }
        if (state.tap !== tap) {
            if (state.visualizer && state.tap) {
                try { state.visualizer.disconnectAudio(state.tap.source); } catch (e) { /* already gone */ }
            }
            state.tap = tap;
            if (state.visualizer && state.visualizerContext !== tap.context) {
                // Butterchurn's analysers live in one AudioContext; a node from another needs a new
                // visualizer, on a fresh canvas since a WebGL context cannot be handed over.
                dropVisualizer();
            }
            if (state.visualizer) { state.visualizer.connectAudio(tap.source); }
        }
        return tap;
    }

    // ---- Butterchurn ---------------------------------------------------------------------------------------

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Jellybutter: failed to load ' + url)); };
            document.head.appendChild(s);
        });
    }

    function ensureLibs() {
        if (!state.libs) {
            state.libs = Promise.all([
                window.butterchurn ? Promise.resolve() : loadScript(JellybutterCore.assetUrl(assetBase, 'butterchurn.js', version)),
                window.butterchurnPresets ? Promise.resolve() : loadScript(JellybutterCore.assetUrl(assetBase, 'butterchurn-presets.js', version))
            ]).then(function () {
                // The UMD bundles expose the ES module namespace: the API is its default export.
                var engine = window.butterchurn && (window.butterchurn.default || window.butterchurn);
                var presets = window.butterchurnPresets && (window.butterchurnPresets.default || window.butterchurnPresets);
                if (!engine || typeof engine.createVisualizer !== 'function' || !presets || typeof presets.getPresets !== 'function') {
                    throw new Error('Jellybutter: the Butterchurn bundles did not define createVisualizer and getPresets');
                }
                state.engine = engine;
                state.presets = presets.getPresets();
                state.names = Object.keys(state.presets).sort();
            }, function (err) {
                state.libs = null;
                throw err;
            });
        }
        return state.libs;
    }

    function viewport() {
        return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight), dpr: window.devicePixelRatio || 1 };
    }

    // Butterchurn's width and height are the canvas buffer in device pixels: its final pass sets the
    // viewport to exactly that, so a buffer larger than width x height is only partly drawn (seen in
    // Jellyfin Desktop at a 1.4 scale factor). Its pixelRatio only scales the internal textures. The
    // buffer is sized to the viewport at the device's pixel ratio for a sharp image and the textures match
    // it one to one.
    function createVisualizer() {
        var size = sizeCanvas();
        state.visualizerContext = state.tap.context;
        state.visualizer = state.engine.createVisualizer(state.visualizerContext, ui.canvas, {
            width: size.w,
            height: size.h,
            pixelRatio: 1,
            textureRatio: 1
        });
        state.visualizer.connectAudio(state.tap.source);
    }

    function sizeCanvas() {
        var v = viewport();
        var size = { w: Math.round(v.w * v.dpr), h: Math.round(v.h * v.dpr) };
        ui.canvas.width = size.w;
        ui.canvas.height = size.h;
        return size;
    }

    function dropVisualizer() {
        state.visualizer = null;
        state.visualizerContext = null;
        var fresh = document.createElement('canvas');
        fresh.className = ui.canvas.className;
        ui.overlay.replaceChild(fresh, ui.canvas);
        ui.canvas = fresh;
        ui.canvas.addEventListener('click', function () { showControls(); });
    }

    function resize() {
        if (!state.open || !state.visualizer) { return; }
        var size = sizeCanvas();
        state.visualizer.setRendererSize(size.w, size.h);
        updateBarInset();
        updateLyrics(true);
    }

    function loadPreset(index, blend) {
        if (!state.visualizer || !state.names.length) { return; }
        state.index = JellybutterCore.stepIndex(index, state.names.length, 0);
        var name = state.names[state.index];
        state.visualizer.loadPreset(state.presets[name], typeof blend === 'number' ? blend : config.blendSeconds);
        ui.toast.textContent = '';
        ui.toast.appendChild(document.createTextNode(name));
        var counter = document.createElement('small');
        counter.textContent = (state.index + 1) + ' / ' + state.names.length;
        ui.toast.appendChild(counter);
        ui.toast.classList.add('jellybutter-shown');
        clearTimeout(state.flashTimer);
        state.flashTimer = setTimeout(function () { ui.toast.classList.remove('jellybutter-shown'); }, NAME_FLASH_MS);
        restartCycle();
    }

    function restartCycle() {
        clearInterval(state.cycleTimer);
        state.cycleTimer = 0;
        if (config.cycleSeconds > 0 && state.open) {
            state.cycleTimer = setInterval(function () {
                loadPreset(JellybutterCore.stepIndex(state.index, state.names.length, 1));
            }, config.cycleSeconds * 1000);
        }
    }

    function render() {
        if (!state.open || !state.visualizer) { state.raf = 0; return; }
        try { state.visualizer.render(); } catch (e) { console.error('[Jellybutter] render failed', e); close(); return; }
        if (state.lyricsOn) { updateLyrics(false); }
        state.raf = requestAnimationFrame(render);
    }

    // ---- Lyrics --------------------------------------------------------------------------------------------

    function setLyrics(on) {
        state.lyricsOn = !!on;
        ui.overlay.classList.toggle('jellybutter-lyrics-on', state.lyricsOn);
        ui.lyricsBtn.setAttribute('aria-pressed', state.lyricsOn ? 'true' : 'false');
        if (state.lyricsOn) {
            loadLyrics();
            updateLyrics(true);
        }
    }

    function lyricsNote(text) {
        ui.lyrics.textContent = '';
        state.lyrics.elements = [];
        var note = document.createElement('p');
        note.className = 'jellybutter-lyric jellybutter-lyric-note';
        note.textContent = text;
        ui.lyrics.appendChild(note);
    }

    /** Fetches the current track's lyrics from Jellyfin's Lyrics API, once per track. */
    function loadLyrics() {
        var id = JellybutterCore.itemIdFromSrc(state.audio && state.audio.currentSrc);
        if (!id || state.lyrics.itemId === id) { return; }
        state.lyrics.itemId = id;
        state.lyrics.data = null;
        ui.lyrics.textContent = '';
        state.lyrics.elements = [];
        var api = window.ApiClient;
        if (!api || typeof api.getJSON !== 'function' || typeof api.getUrl !== 'function') {
            lyricsNote('Lyrics are not available here.');
            return;
        }
        var request;
        try { request = api.getJSON(api.getUrl('Audio/' + id + '/Lyrics')); } catch (e) { request = Promise.reject(e); }
        Promise.resolve(request).then(function (dto) {
            if (state.lyrics.itemId !== id) { return; }
            state.lyrics.data = JellybutterCore.normalizeLyrics(dto);
            renderLyrics();
        }, function () {
            // 404: the track has no lyrics (or no lyrics plugin found any).
            if (state.lyrics.itemId !== id) { return; }
            state.lyrics.data = null;
            renderLyrics();
        });
    }

    function renderLyrics() {
        var data = state.lyrics.data;
        state.lyrics.index = -2;
        state.lyrics.offset = null;
        if (!data) {
            lyricsNote('No lyrics for this track.');
            return;
        }
        ui.lyrics.textContent = '';
        ui.lyrics.classList.toggle('jellybutter-lyrics-synced', data.synced);
        var holder = document.createElement('div');
        holder.className = data.synced ? 'jellybutter-lyrics-scroll' : 'jellybutter-lyrics-block';
        state.lyrics.elements = data.lines.map(function (line) {
            var p = document.createElement('p');
            p.className = 'jellybutter-lyric' + (data.synced ? ' jellybutter-lyric-future' : '');
            p.textContent = line.text || ' ';
            holder.appendChild(p);
            return p;
        });
        state.lyrics.holder = holder;
        ui.lyrics.appendChild(holder);
        updateLyrics(true);
    }

    /** Follows the audio clock: moves the current synced line to the center, or scrolls an unsynced block. */
    function updateLyrics(force) {
        var data = state.lyrics.data;
        var holder = state.lyrics.holder;
        if (!data || !holder || !state.audio || !holder.parentNode) { return; }
        var time = state.audio.currentTime || 0;
        var viewHeight = ui.lyrics.clientHeight || window.innerHeight;
        if (data.synced) {
            var index = JellybutterCore.lyricIndexAt(data.lines, time);
            if (!force && index === state.lyrics.index) { return; }
            state.lyrics.index = index;
            state.lyrics.elements.forEach(function (el, i) {
                el.className = 'jellybutter-lyric ' + (i < index ? 'jellybutter-lyric-past' : i === index ? 'jellybutter-lyric-active' : 'jellybutter-lyric-future');
            });
            var anchor = state.lyrics.elements[Math.max(0, index)];
            if (anchor) {
                // Measured after the class change so the active size counts; the transform then eases in.
                var center = anchor.offsetTop + anchor.offsetHeight / 2;
                holder.style.transform = 'translateY(' + Math.round(viewHeight / 2 - center) + 'px)';
            }
            return;
        }
        var blockHeight = holder.scrollHeight;
        var tall = blockHeight > viewHeight;
        holder.classList.toggle('jellybutter-lyrics-tall', tall);
        var duration = state.audio.duration;
        var progress = duration > 0 ? time / duration : 0;
        var offset = JellybutterCore.blockOffset(blockHeight, viewHeight, progress);
        if (force || offset !== state.lyrics.offset) {
            state.lyrics.offset = offset;
            holder.style.transform = tall ? 'translateY(' + offset + 'px)' : '';
        }
    }

    // ---- Now Playing bar -----------------------------------------------------------------------------------

    // jellyfin-web's bar listens for viewbeforeshow on the document and shows itself (and keeps updating)
    // only while the last one said options.enableMediaControl. Real ones come from the view element and
    // bubble up; ours is dispatched on the document itself, which no view's own listener sees, and is
    // marked so this script's listener skips it.
    function tellBar(allowed) {
        var detail = { isRestored: true, options: { enableMediaControl: allowed }, jellybutter: true };
        document.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: false, cancelable: false, detail: detail }));
    }

    function onViewBeforeShow(e) {
        var detail = e.detail;
        if (!detail || detail.jellybutter) { return; }
        state.pageMediaControl = !!(detail.options && detail.options.enableMediaControl);
        // A page change under the open visualizer (the bar's own link to Now Playing) hides the bar again;
        // put it back once jellyfin-web's handler, later on the bubbling path, has run.
        if (state.open && config.nowPlayingBar) {
            setTimeout(function () {
                if (state.open) { tellBar(JellybutterCore.mediaControlFor(true, true, state.pageMediaControl)); }
            }, 0);
        }
    }

    function updateBarInset() {
        var bar = config.nowPlayingBar && state.open ? document.querySelector('.appfooter .nowPlayingBar') : null;
        var footer = bar && bar.closest('.appfooter');
        var inset = JellybutterCore.barInset(bar ? bar.className : null, footer ? footer.offsetHeight : 0);
        ui.overlay.style.setProperty('--jellybutter-bar', inset + 'px');
    }

    function showBar() {
        if (!config.nowPlayingBar) { return; }
        document.documentElement.classList.add('jellybutter-bar');
        tellBar(JellybutterCore.mediaControlFor(true, true, state.pageMediaControl));
        // jellyfin-web builds the bar on first show and toggles its classes as playback changes.
        var footer = document.querySelector('.appfooter');
        if (footer && !state.barObserver) {
            state.barObserver = new MutationObserver(updateBarInset);
            state.barObserver.observe(footer, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        }
        updateBarInset();
    }

    function hideBar() {
        if (!config.nowPlayingBar) { return; }
        if (state.barObserver) { state.barObserver.disconnect(); state.barObserver = null; }
        document.documentElement.classList.remove('jellybutter-bar');
        tellBar(JellybutterCore.mediaControlFor(false, true, state.pageMediaControl));
        updateBarInset();
    }

    // ---- Open / close --------------------------------------------------------------------------------------

    var opening = false;

    function open() {
        if (state.open || opening || !state.audio || state.unsupported) { return; }
        opening = true;
        try {
            // Any context this makes is created inside the gesture, as autoplay policy requires.
            connect();
        } catch (err) {
            opening = false;
            console.error('[Jellybutter] could not attach to the audio element', err);
            return;
        }
        ensureLibs().then(function () {
            opening = false;
            if (!state.audio || !state.tap) { return; }
            state.open = true;
            state.lastFocus = document.activeElement;
            ui.overlay.classList.add('jellybutter-open');
            ui.toggle.setAttribute('aria-pressed', 'true');
            try {
                if (!state.visualizer) { createVisualizer(); } else { resize(); }
            } catch (err) {
                // Butterchurn needs WebGL 2; a browser without it throws inside createVisualizer. Say so
                // once where the user is looking, then stop offering the button for this page.
                unsupported(err);
                return;
            }
            loadPreset(JellybutterCore.randomIndex(state.names.length, -1), 0);
            showBar();
            setLyrics(config.defaultView === 'lyrics');
            render();
            showControls();
            refreshButtons();
            moveFocus(ui.next);
        }, function (err) {
            opening = false;
            console.error('[Jellybutter]', err);
        });
    }

    function unsupported(err) {
        console.error('[Jellybutter] this browser cannot run the visualizer (WebGL 2 is required)', err);
        state.unsupported = true;
        ui.toast.textContent = 'The visualizer needs WebGL 2, which this browser does not provide.';
        ui.toast.classList.add('jellybutter-shown');
        setTimeout(function () {
            ui.toast.classList.remove('jellybutter-shown');
            close();
            refreshButtons();
        }, NAME_FLASH_MS);
    }

    function close() {
        if (!state.open) { return; }
        state.open = false;
        cancelAnimationFrame(state.raf);
        state.raf = 0;
        clearInterval(state.cycleTimer);
        state.cycleTimer = 0;
        ui.overlay.classList.remove('jellybutter-open');
        ui.toggle.setAttribute('aria-pressed', 'false');
        hideBar();
        refreshButtons();
        var back = state.lastFocus;
        state.lastFocus = null;
        var row = findControlRow();
        var control = row && row.querySelector('.btnJellybutter');
        if (control && isOnScreen(control)) {
            moveFocus(control);
        } else if (ui.toggleWrap.classList.contains('jellybutter-visible')) {
            moveFocus(ui.toggle);
        } else if (back && typeof back.focus === 'function' && document.contains(back)) {
            moveFocus(back);
        }
    }

    // Focus moves a moment after the action, never inside the key event that caused it: in the TV layout
    // jellyfin-web clicks the focused element on Enter's keydown and the browser then activates whatever
    // is focused on the key's own default action, so a focus change inside the handler would hand that
    // second activation to the newly focused button (Close reopened the visualizer; the toggle stepped
    // to the next preset).
    var focusTimer = 0;
    function moveFocus(el) {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(function () {
            if (el && typeof el.focus === 'function' && document.contains(el)) { el.focus({ preventScroll: true }); }
        }, 100);
    }

    function toggle() {
        if (state.open) { close(); } else { open(); }
    }

    function onKeyDown(e) {
        if (e.defaultPrevented) { return; }
        var t = e.target;
        if (t && JellybutterCore.isTypingTarget(t.tagName, t.isContentEditable)) { return; }
        var action = JellybutterCore.hotkeyFor(e.key, state.open, state.trackLoaded, e);
        if (!action) { return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (action === 'toggle') { toggle(); }
        else if (action === 'close') { close(); }
        else if (action === 'lyrics') { setLyrics(!state.lyricsOn); }
        else if (action === 'next') { loadPreset(JellybutterCore.stepIndex(state.index, state.names.length, 1)); }
        else if (action === 'prev') { loadPreset(JellybutterCore.stepIndex(state.index, state.names.length, -1)); }
    }

    function start() {
        buildUi();
        startObserver();
        // A read-only handle for diagnosing a client in the field (devtools, or a remote-debugging port).
        window.jellybutter = { version: version, config: config, core: JellybutterCore, state: state };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
