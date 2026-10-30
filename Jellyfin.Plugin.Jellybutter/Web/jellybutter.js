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
 *     offsetParent is null, which a fixed-position element's always is. Its bars bounce while music plays.
 *   - Listens on the element's Web Audio source node. jellyfin-web's own audio player routes the element
 *     through an AudioContext of its own (a gain node for volume normalization) as playback starts, and an
 *     element can feed only one MediaElementAudioSourceNode, so createMediaElementSource is wrapped at
 *     load to capture the context and node whichever side connects first; an element nobody connected
 *     gets a context of the script's own. On first open it lazy-loads the two Butterchurn bundles from the
 *     plugin, then renders full screen with a random starting preset, auto-cycling, blended changes and
 *     a preset-name flash.
 *   - Lyrics view: the track's lyrics from Jellyfin's Lyrics API over the visualizer. Synced lyrics follow
 *     the audio element's clock with the current line large and glowing; unsynced lyrics (no timestamps,
 *     so nothing to follow) sit still, whole, sized down or set in columns until they fit.
 *   - Now Playing bar: jellyfin-web's own bar along the bottom of the visualizer, live, on every page. jellyfin-web
 *     shows it only on views whose options allow media control, read from the viewbeforeshow event on the
 *     document; opening tells it "allowed" with that same event and closing hands back the page's own value.
 *     The TV layout has no such bar (jellyfin-web never builds it there), so there the visualizer shows its
 *     own: title, artist and artwork from the Media Session metadata jellyfin-web publishes, and transport
 *     buttons calling the Media Session handlers it registers (captured at load, like the source nodes).
 *   - Hotkeys: v toggles the visualizer, l toggles lyrics, b next preset, n previous preset, Escape closes.
 *     Ignored while typing in a field.
 *   - D-pad: while open, arrows (keyboard, remote, or a gamepad through jellyfin-web's gamepad setting) wake
 *     the controls and move between them and the Now Playing bar's buttons, Enter or A presses. Back (B,
 *     Escape) hides the UI, leaving the track, artwork, time and progress; a second Back closes. In the Now
 *     Playing row, left and right step through the buttons around the visualizer button in row order.
 *   - Idle visualizer: while music plays and nothing is pressed for the set minutes, it opens by itself,
 *     with the UI hidden by default.
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
        lyricsSize: 'medium',
        idleVisualizer: true,
        idleMinutes: 2,
        idleHideUi: true
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
            var idle = Number(parsed.idleMinutes);
            var flag = function (name) { return typeof parsed[name] === 'boolean' ? parsed[name] : DEFAULTS[name]; };
            return {
                desktopWebAudio: flag('desktopWebAudio'),
                cycleSeconds: isFinite(cycle) && cycle >= 0 ? cycle : DEFAULTS.cycleSeconds,
                blendSeconds: isFinite(blend) && blend >= 0 ? blend : DEFAULTS.blendSeconds,
                controlButton: flag('controlButton'),
                floatingButton: flag('floatingButton'),
                nowPlayingBar: flag('nowPlayingBar'),
                defaultView: pickOne(parsed.defaultView, VIEWS, DEFAULTS.defaultView),
                lyricsSize: pickOne(parsed.lyricsSize, LYRICS_SIZES, DEFAULTS.lyricsSize),
                idleVisualizer: flag('idleVisualizer'),
                idleMinutes: isFinite(idle) ? Math.min(60, Math.max(1, Math.round(idle))) : DEFAULTS.idleMinutes,
                idleHideUi: flag('idleHideUi')
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

        /** A Jellyfin Desktop plugin list with `name` added once; anything that is not a list passes through. */
        addNativePlugin: function (plugins, name) {
            if (!Array.isArray(plugins) || plugins.indexOf(name) >= 0) { return plugins; }
            return plugins.concat([name]);
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
        isPlaying: function (audio) {
            return !!audio && !audio.paused && !audio.ended;
        },

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

        /**
         * The navigation a key means while the visualizer is open: 'left', 'right', 'up', 'down', 'select',
         * 'back' or null. Covers the keyboard, TV remotes and jellyfin-web's gamepad translation (with
         * "Enable gamepad" on it sends keydown events keyed GamepadDPadLeft, GamepadA, GamepadB and so on,
         * with the arrow, Enter and Escape key codes), the same tables jellyfin-web's own navigation reads.
         */
        navKeyFor: function (key, keyCode, modifiers) {
            if (modifiers && (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey || modifiers.shiftKey)) { return null; }
            var byKey = {
                ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
                GamepadDPadLeft: 'left', GamepadDPadRight: 'right', GamepadDPadUp: 'up', GamepadDPadDown: 'down',
                GamepadLeftThumbStickLeft: 'left', GamepadLeftThumbStickRight: 'right',
                GamepadLeftThumbStickUp: 'up', GamepadLeftThumbStickDown: 'down',
                NavigationLeft: 'left', NavigationRight: 'right', NavigationUp: 'up', NavigationDown: 'down',
                Enter: 'select', GamepadA: 'select',
                Escape: 'back', GamepadB: 'back', Back: 'back', BrowserBack: 'back', GoBack: 'back'
            };
            if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(byKey, key)) { return byKey[key]; }
            // Remotes that send only a key code: 461 and 10009 are webOS and Tizen's Back.
            var byCode = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'select', 27: 'back', 461: 'back', 10009: 'back' };
            return Object.prototype.hasOwnProperty.call(byCode, keyCode) ? byCode[keyCode] : null;
        },

        /**
         * The navigation one of jellyfin-web's input commands means, or null. Jellyfin Desktop sends its
         * controllers, remotes and (in its TV mode) keyboard as commands rather than key events: the D-pad as
         * up/down/left/right, A as select, B as back.
         */
        navCommandFor: function (command) {
            var map = { up: 'up', down: 'down', left: 'left', right: 'right', select: 'select', back: 'back' };
            return typeof command === 'string' && Object.prototype.hasOwnProperty.call(map, command) ? map[command] : null;
        },

        /**
         * D-pad focus movement: the index of the rect to go to from `from` in a direction, or -1. A candidate
         * must lie that way (its center past the current center); one that overlaps the current rect across
         * the direction is in line and costs only its distance, others pay double for drifting sideways.
         */
        nextFocusIndex: function (from, rects, direction) {
            if (!from || !Array.isArray(rects)) { return -1; }
            var horizontal = direction === 'left' || direction === 'right';
            var sign = direction === 'left' || direction === 'up' ? -1 : 1;
            if (!horizontal && direction !== 'up' && direction !== 'down') { return -1; }
            var fx = (from.left + from.right) / 2;
            var fy = (from.top + from.bottom) / 2;
            var best = -1;
            var bestScore = Infinity;
            rects.forEach(function (r, i) {
                if (!r || !(r.right > r.left) || !(r.bottom > r.top)) { return; }
                var cx = (r.left + r.right) / 2;
                var cy = (r.top + r.bottom) / 2;
                var along = horizontal ? (cx - fx) * sign : (cy - fy) * sign;
                if (!(along > 1)) { return; }
                var inLine = horizontal ? r.bottom > from.top && r.top < from.bottom : r.right > from.left && r.left < from.right;
                var across = inLine ? 0 : Math.abs(horizontal ? cy - fy : cx - fx);
                var score = along + across * 2;
                if (score < bestScore) { bestScore = score; best = i; }
            });
            return best;
        },

        /**
         * Whether the idle visualizer should open now: the setting is on, music is playing in a visible page,
         * the visualizer is neither open nor opening nor known not to work, and nothing was pressed for the
         * idle minutes.
         */
        shouldIdleOpen: function (cfg, s) {
            if (!cfg || !cfg.idleVisualizer || !s) { return false; }
            if (s.open || s.opening || s.unsupported || !s.playing || s.hidden) { return false; }
            return s.idleMs >= cfg.idleMinutes * 60000;
        },

        /**
         * Left/right through the Now Playing row around the visualizer button, by the row's own order:
         * jellyfin-web's D-pad choice is geometry, and with the volume control wrapped under the row, right
         * from Lyrics drops onto it instead of reaching the button. Given the row's visible buttons, the
         * button's index and the focused one's, the index to focus, or -1 to leave the key to jellyfin-web.
         */
        rowStep: function (count, ours, current, direction) {
            if (!(ours >= 0) || !(current >= 0) || ours >= count || current >= count) { return -1; }
            var step = direction === 'right' ? 1 : direction === 'left' ? -1 : 0;
            if (!step) { return -1; }
            if (current === ours) {
                var next = ours + step;
                return next >= 0 && next < count ? next : -1;
            }
            return current + step === ours ? ours : -1;
        },

        /**
         * Where the floating button goes so it clears jellyfin-web's A-Z picker, which sits fixed along the
         * right edge of list pages: its distance from the right edge in pixels, or null to keep the default
         * spot when no picker is showing on the right half.
         */
        toggleRight: function (pickerRect, viewportWidth, gap) {
            if (!pickerRect || !(pickerRect.width > 0) || !(viewportWidth > 0)) { return null; }
            if (pickerRect.left < viewportWidth / 2) { return null; }
            return Math.round(viewportWidth - pickerRect.left + (gap > 0 ? gap : 0));
        },

        /** A playback position as m:ss, or h:mm:ss from an hour; empty for an unknown time. */
        formatTime: function (seconds) {
            if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) { return ''; }
            var s = Math.floor(seconds);
            var h = Math.floor(s / 3600);
            var m = Math.floor((s % 3600) / 60);
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            return h > 0 ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
        },

        /** The largest image of a Media Session artwork list ([{ src, sizes: '512x512' }]), or null. */
        pickArtwork: function (artwork) {
            var list = Array.isArray(artwork) ? artwork.filter(function (a) { return a && typeof a.src === 'string' && a.src; }) : [];
            var size = function (a) {
                var m = /(\d+)x(\d+)/.exec(a.sizes || '');
                return m ? Number(m[1]) * Number(m[2]) : 0;
            };
            var best = null;
            list.forEach(function (a) { if (!best || size(a) > size(best)) { best = a; } });
            return best ? best.src : null;
        },

        /** The second line of the TV Now Playing bar: artist and album, whichever are known. */
        trackSubtitle: function (artist, album) {
            return [artist, album].filter(function (s) { return typeof s === 'string' && s.trim(); }).join(' — ');
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
         * How to show unsynced lyrics whole and still: they carry no timing, so any movement would be a
         * guess. `measure(scale, columns)` lays the block out at that text scale and column count and returns
         * its height. The largest scale that fits `available` wins, trying one column down to 0.7 of the set
         * size, then two down to 0.55, then three down to 0.45; past that, three columns at 0.45.
         */
        fitLyrics: function (measure, available) {
            var floors = [0.7, 0.55, 0.45];
            if (typeof measure !== 'function' || !(available > 0)) { return { scale: 1, columns: 1 }; }
            for (var columns = 1; columns <= floors.length; columns++) {
                if (measure(1, columns) <= available) { return { scale: 1, columns: columns }; }
                var lo = floors[columns - 1];
                if (measure(lo, columns) > available) { continue; }
                var hi = 1;
                for (var i = 0; i < 7; i++) {
                    var mid = (lo + hi) / 2;
                    if (measure(mid, columns) <= available) { lo = mid; } else { hi = mid; }
                }
                return { scale: Math.floor(lo * 100) / 100, columns: columns };
            }
            return { scale: floors[floors.length - 1], columns: floors.length };
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

    // Jellyfin Desktop turns controller, remote and TV-mode keyboard presses into jellyfin-web input
    // commands (inputManager.handleCommand), never key events, and jellyfin-web dispatches a command as a
    // cancelable "command" DOM event only while something registered through inputManager.on. Nothing global
    // exposes inputManager, but jellyfin-web hands it to every plugin the shell lists, so the visualizer
    // lists one of its own: it registers, and onCommand then sees each command ahead of the page.
    (function addInputPlugin() {
        var shell = window.NativeShell;
        var name = 'jellybutterInputPlugin';
        if (!shell || typeof shell.getPlugins !== 'function' || window[name]) { return; }
        function JellybutterInputPlugin(deps) {
            this.name = 'Jellybutter Input';
            this.type = 'input';
            this.id = name;
            var inputManager = deps && deps.inputManager;
            if (inputManager && typeof inputManager.on === 'function') {
                inputManager.on(window, noop);
                window.addEventListener('command', onCommand, true);
                console.info('[Jellybutter] Jellyfin Desktop: controller and remote commands reach the visualizer.');
            }
        }
        // jellyfin-web loads a listed name as window[name], a function returning the plugin class.
        window[name] = function () { return JellybutterInputPlugin; };
        var originalPlugins = shell.getPlugins;
        shell.getPlugins = function () {
            var list = originalPlugins.apply(this, arguments);
            if (list && typeof list.then === 'function') {
                return list.then(function (resolved) { return JellybutterCore.addNativePlugin(resolved, name); });
            }
            return JellybutterCore.addNativePlugin(list, name);
        };
    })();

    // Media Session action -> handler, as jellyfin-web registers them (play, pause, previoustrack,
    // nexttrack, seekbackward, seekforward, ...): each calls its playback manager, which has no global
    // handle. Recorded by a wrap installed now, before jellyfin-web's deferred bundles register them; the
    // TV layout's Now Playing bar drives playback through them.
    var mediaActions = {};

    (function captureMediaActions() {
        var session = navigator.mediaSession;
        if (!session || typeof session.setActionHandler !== 'function') { return; }
        var original = session.setActionHandler;
        session.setActionHandler = function (action, handler) {
            mediaActions[action] = typeof handler === 'function' ? handler : null;
            return original.apply(this, arguments);
        };
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
        lyrics: { itemId: null, data: null, index: -2, elements: [] },
        raf: 0,
        cycleTimer: 0,
        flashTimer: 0,
        stopTimer: 0,
        libs: null,             // Promise for the bundles
        unsupported: false,     // set once the browser proved it has no WebGL 2
        lastFocus: null,
        pageMediaControl: null, // enableMediaControl of the page jellyfin-web last showed; null until one shows
        barObserver: null,      // watches the Now Playing bar while the visualizer shows it
        ownBar: false,          // the visualizer's own Now Playing bar is up (TV layout or hidden UI, see applyBar)
        webBar: false,          // jellyfin-web's bar is raised over the visualizer (see applyBar)
        uiHidden: false,        // controls and bar buttons hidden: Back, or the idle visualizer (see setUiHidden)
        barMeta: undefined,     // the Media Session metadata the TV bar last showed
        barPaused: null,
        barTime: null,
        barFraction: -1,
        barInset: -1            // the --jellybutter-bar value last set, in px
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
            // While music plays, the floating button's bars bounce like a level meter: each line scales from
            // its foot on its own period, so they never move in step. Still for reduced motion.
            '@keyframes jellybutter-eq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.3)}}',
            '.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line{transform-box:fill-box;transform-origin:50% 100%;animation:jellybutter-eq .9s ease-in-out infinite}',
            '.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line:nth-child(2){animation-duration:.7s;animation-delay:-.3s}',
            '.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line:nth-child(3){animation-duration:1.1s;animation-delay:-.6s}',
            '.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line:nth-child(4){animation-duration:.8s;animation-delay:-.2s}',
            '.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line:nth-child(5){animation-duration:1s;animation-delay:-.5s}',
            '@media (prefers-reduced-motion:reduce){.jellybutter-toggle-wrap.jellybutter-playing .jellybutter-toggle line{animation:none}}',
            '.jellybutter-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none;font-family:inherit}',
            // The page's own scrollbar paints beside a fixed overlay, not under it: no page scrolling while open.
            'html.jellybutter-open,html.jellybutter-open body{overflow:hidden!important}',
            '.jellybutter-overlay.jellybutter-open{display:block}',
            '.jellybutter-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
            '.jellybutter-toast{position:absolute;top:1em;left:1em;padding:.5em .9em;background:rgba(0,0,0,.55);color:#fff;border-radius:.5em;font:600 .95em/1.3 sans-serif;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .3s}',
            '.jellybutter-toast.jellybutter-shown{opacity:1}',
            // Says the lyrics on screen carry no timing, so their stillness reads as intended.
            '.jellybutter-lyrics-badge{position:absolute;top:1em;right:1em;display:none;padding:.3em .75em;border-radius:1em;background:rgba(0,0,0,.45);color:rgba(255,255,255,.6);font:500 .8em/1.3 sans-serif;pointer-events:none}',
            '.jellybutter-overlay.jellybutter-lyrics-on.jellybutter-lyrics-unsynced .jellybutter-lyrics-badge{display:block}',
            '.jellybutter-toast small{display:block;font-weight:400;font-size:.75em;color:rgba(255,255,255,.55)}',
            '.jellybutter-controls{position:absolute;right:1em;bottom:calc(1em + var(--jellybutter-bar,0px));display:flex;gap:.3em;opacity:0;transition:opacity .3s}',
            // Shown while the pointer is over the overlay and for a moment after any key, never merely
            // because a control holds focus: on a TV the focus stays on a control while the screen is left
            // to the visualizer, and a D-pad press brings them back (see onNav).
            '.jellybutter-overlay:hover .jellybutter-controls,.jellybutter-overlay.jellybutter-controls-shown .jellybutter-controls{opacity:1}',
            '.jellybutter-ctrl{width:2.4em;height:2.4em;border:none;border-radius:50%;background:rgba(0,0,0,.5);color:rgba(255,255,255,.85);font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
            '.jellybutter-ctrl:hover,.jellybutter-ctrl:focus{background:rgba(0,164,220,.85);color:#fff;outline:none}',
            '.jellybutter-ctrl:focus-visible{box-shadow:0 0 0 .2em #fff}',
            '.jellybutter-ctrl[aria-pressed="true"]{background:rgba(0,164,220,.55);color:#fff}',
            '.jellybutter-ctrl svg{width:1.2em;height:1.2em}',
            '.jellybutter-ctrl[hidden]{display:none}',
            '.jellybutter-ctrl.jellybutter-ctrl-main{width:3em;height:3em}',
            '.jellybutter-ctrl.jellybutter-ctrl-main svg{width:1.5em;height:1.5em}',
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
            '.jellybutter-lyrics-block{position:absolute;left:8vw;right:8vw;top:50%;transform:translateY(-50%);column-gap:6vw}',
            // No font-size transition here: fitLyrics measures each size it tries, and a transitioning line
            // would still report the previous one.
            '.jellybutter-lyrics-block .jellybutter-lyric{break-inside:avoid;transition:none}',
            // Readable over any preset: a dark stroke under the fill, a dark drop shadow, and on the
            // current line the accent glow.
            '.jellybutter-lyric{margin:0;padding:.18em 0;color:rgba(255,255,255,.92);font-size:var(--jellybutter-line);font-weight:500;line-height:1.3;' +
                '-webkit-text-stroke:2px rgba(0,0,0,.75);paint-order:stroke fill;text-shadow:0 2px 4px rgba(0,0,0,.9);' +
                'transition:color .4s,font-size .4s,text-shadow .4s,opacity .4s;min-height:1.3em}',
            '.jellybutter-lyric-past{opacity:.6;color:rgba(255,255,255,.8)}',
            '.jellybutter-lyric-future{opacity:.8}',
            '.jellybutter-lyric-active{opacity:1;color:#fff;font-size:var(--jellybutter-active);font-weight:700;-webkit-text-stroke:2px rgba(0,0,0,.8);' +
                'text-shadow:0 0 20px rgba(0,164,220,.5),0 0 40px rgba(0,164,220,.25),0 2px 4px rgba(0,0,0,.9)}',
            // A note in place of lyrics ("No lyrics found"): small and faint at the bottom, just above the bar,
            // with the edge fade off so the bottom of the column does not swallow it.
            '.jellybutter-lyric-note{position:absolute;left:8vw;right:8vw;top:auto;bottom:1.2em;transform:none;font-size:.95em;color:rgba(255,255,255,.3);font-weight:400;-webkit-text-stroke:0;text-shadow:0 1px 2px rgba(0,0,0,.5)}',
            '.jellybutter-lyrics.jellybutter-lyrics-noted{-webkit-mask-image:none;mask-image:none}',
            // The TV layout's Now Playing bar (jellyfin-web builds none there): artwork, title and artist,
            // transport buttons, the time, and a progress line along its top edge.
            '.jellybutter-tvbar{position:absolute;left:0;right:0;bottom:0;display:none;align-items:center;gap:1.2em;padding:.9em 2em;background:rgba(16,16,16,.88);color:#fff}',
            '.jellybutter-overlay.jellybutter-tvbar-on .jellybutter-tvbar{display:flex}',
            '.jellybutter-tvbar-progress{position:absolute;left:0;right:0;top:0;height:.2em;background:rgba(255,255,255,.15)}',
            '.jellybutter-tvbar-fill{height:100%;background:#00a4dc;transform-origin:0 50%;transform:scaleX(0)}',
            '.jellybutter-tvbar-art{width:3.6em;height:3.6em;object-fit:cover;border-radius:.3em;flex:none}',
            '.jellybutter-tvbar-art[hidden]{display:none}',
            // Equal side columns, so the buttons sit at the center of the screen, under the lyrics.
            '.jellybutter-tvbar-info,.jellybutter-tvbar-time{flex:1 1 0;min-width:0}',
            '.jellybutter-tvbar-info{display:flex;align-items:center;gap:1.2em}',
            '.jellybutter-tvbar-text{flex:1 1 auto;min-width:0}',
            '.jellybutter-tvbar-title,.jellybutter-tvbar-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.jellybutter-tvbar-title{font-weight:600;font-size:1.05em}',
            '.jellybutter-tvbar-sub{margin-top:.2em;font-size:.85em;color:rgba(255,255,255,.6)}',
            '.jellybutter-tvbar-buttons{display:flex;align-items:center;gap:.5em;flex:none}',
            '.jellybutter-tvbar-time{text-align:right;font-size:.9em;color:rgba(255,255,255,.7);font-variant-numeric:tabular-nums}',
            // Hidden UI (Back, or the idle visualizer): no controls, no bar buttons or background, no preset
            // name or badge. The track, artwork, time and progress stay, the progress line along the very bottom.
            '.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-controls,.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-tvbar-buttons,' +
                '.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-toast,.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-lyrics-badge{display:none}',
            '.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-tvbar{background:transparent;text-shadow:0 1px 3px rgba(0,0,0,.9)}',
            '.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-tvbar-progress{top:auto;bottom:0}',
            '.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-tvbar-sub,.jellybutter-overlay.jellybutter-ui-hidden .jellybutter-tvbar-time{color:rgba(255,255,255,.8)}',
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
        close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        play: '<polygon points="6 4 20 12 6 20 6 4"/>',
        pause: '<line x1="8" y1="5" x2="8" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/>',
        trackPrev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
        trackNext: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
        rewind: '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>',
        forward: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>'
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
        ui.lyricsBadge = document.createElement('div');
        ui.lyricsBadge.className = 'jellybutter-lyrics-badge';
        ui.lyricsBadge.textContent = 'Unsynced lyrics';
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
        ui.overlay.appendChild(ui.lyricsBadge);
        ui.overlay.appendChild(ui.toast);
        ui.overlay.appendChild(ui.controls);
        ui.overlay.appendChild(buildTvBar());
        ui.canvas.addEventListener('click', onPointer);
        ui.overlay.addEventListener('mousemove', onPointer);
        ui.overlay.addEventListener('focusin', function () { if (!state.uiHidden) { showControls(); } });
        document.body.appendChild(ui.overlay);

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', resize);
        window.addEventListener('resize', scheduleRefresh);
    }

    function buildTvBar() {
        ui.tvBar = document.createElement('div');
        ui.tvBar.className = 'jellybutter-tvbar';
        ui.tvBar.setAttribute('role', 'group');
        ui.tvBar.setAttribute('aria-label', 'Now playing');
        var progress = document.createElement('div');
        progress.className = 'jellybutter-tvbar-progress';
        ui.tvFill = document.createElement('div');
        ui.tvFill.className = 'jellybutter-tvbar-fill';
        progress.appendChild(ui.tvFill);
        ui.tvArt = document.createElement('img');
        ui.tvArt.className = 'jellybutter-tvbar-art';
        ui.tvArt.alt = '';
        ui.tvArt.hidden = true;
        var text = document.createElement('div');
        text.className = 'jellybutter-tvbar-text';
        ui.tvTitle = document.createElement('div');
        ui.tvTitle.className = 'jellybutter-tvbar-title';
        ui.tvSub = document.createElement('div');
        ui.tvSub.className = 'jellybutter-tvbar-sub';
        text.appendChild(ui.tvTitle);
        text.appendChild(ui.tvSub);
        var info = document.createElement('div');
        info.className = 'jellybutter-tvbar-info';
        info.appendChild(ui.tvArt);
        info.appendChild(text);
        var buttons = document.createElement('div');
        buttons.className = 'jellybutter-tvbar-buttons';
        ui.tvPrev = button('jellybutter-ctrl', 'Previous track', ICONS.trackPrev, function () { mediaAction('previoustrack'); });
        ui.tvRewind = button('jellybutter-ctrl', 'Rewind', ICONS.rewind, function () { mediaAction('seekbackward'); });
        ui.tvPlay = button('jellybutter-ctrl jellybutter-ctrl-main', 'Pause', ICONS.pause, playPause);
        ui.tvForward = button('jellybutter-ctrl', 'Fast forward', ICONS.forward, function () { mediaAction('seekforward'); });
        ui.tvNext = button('jellybutter-ctrl', 'Next track', ICONS.trackNext, function () { mediaAction('nexttrack'); });
        [ui.tvPrev, ui.tvRewind, ui.tvPlay, ui.tvForward, ui.tvNext].forEach(function (b) { buttons.appendChild(b); });
        ui.tvTime = document.createElement('div');
        ui.tvTime.className = 'jellybutter-tvbar-time';
        [progress, info, buttons, ui.tvTime].forEach(function (el) { ui.tvBar.appendChild(el); });
        return ui.tvBar;
    }

    /** The pointer brings a hidden UI back, and shows the controls for a moment. */
    function onPointer() {
        if (state.uiHidden) { setUiHidden(false); }
        showControls();
    }

    var controlsTimer = 0;
    function controlsShown() {
        return ui.overlay.classList.contains('jellybutter-controls-shown');
    }

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
        if (placement.floating) {
            var right = JellybutterCore.toggleRight(visibleRect(document.querySelectorAll('.alphaPicker-fixed-right')), window.innerWidth, 12);
            ui.toggleWrap.style.right = right === null ? '' : right + 'px';
        }
    }

    /** The box of the first of `elements` that is on screen; jellyfin-web keeps hidden pages in the DOM. */
    function visibleRect(elements) {
        for (var i = 0; i < elements.length; i++) {
            var r = elements[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { return r; }
        }
        return null;
    }

    /** Left/right between the Now Playing row's buttons around the visualizer button, by the row's order. */
    function rowArrow(direction) {
        var row = findControlRow();
        var mine = row && row.querySelector('.btnJellybutter');
        if (!mine || !isOnScreen(mine)) { return false; }
        var buttons = Array.prototype.filter.call(row.querySelectorAll('button'), isOnScreen);
        var target = JellybutterCore.rowStep(buttons.length, buttons.indexOf(mine), buttons.indexOf(document.activeElement), direction);
        if (target < 0) { return false; }
        buttons[target].focus();
        return true;
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
        ui.toggleWrap.classList.toggle('jellybutter-playing', JellybutterCore.isPlaying(state.audio));
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
        ui.canvas.addEventListener('click', onPointer);
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
        if (state.ownBar) { updateTvBar(); }
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
        ui.overlay.classList.remove('jellybutter-lyrics-unsynced');
        ui.lyrics.classList.add('jellybutter-lyrics-noted');
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
        ui.overlay.classList.remove('jellybutter-lyrics-unsynced');
        ui.lyrics.classList.remove('jellybutter-lyrics-noted');
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
        if (!data) {
            lyricsNote('No lyrics found');
            return;
        }
        ui.lyrics.textContent = '';
        ui.lyrics.classList.toggle('jellybutter-lyrics-synced', data.synced);
        ui.lyrics.classList.remove('jellybutter-lyrics-noted');
        ui.overlay.classList.toggle('jellybutter-lyrics-unsynced', !data.synced);
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

    /**
     * Follows the audio clock for synced lyrics, moving the current line to the center. Unsynced lyrics have
     * no clock to follow: they are fitted to the view once per layout (force) and never move.
     */
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
        if (!force) { return; }
        // Clear of the faded top and bottom edges (the mask's 12% each way).
        var fit = JellybutterCore.fitLyrics(function (scale, columns) {
            holder.style.fontSize = scale + 'em';
            holder.style.columnCount = columns > 1 ? String(columns) : '';
            return holder.scrollHeight;
        }, Math.floor(viewHeight * 0.76));
        holder.style.fontSize = fit.scale + 'em';
        holder.style.columnCount = fit.columns > 1 ? String(fit.columns) : '';
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
        if (state.open && state.webBar) {
            setTimeout(function () {
                if (state.open) { tellBar(JellybutterCore.mediaControlFor(true, true, state.pageMediaControl)); }
            }, 0);
        }
    }

    function updateBarInset() {
        var inset = 0;
        if (state.ownBar) {
            inset = ui.tvBar.offsetHeight;
        } else {
            var bar = state.webBar ? document.querySelector('.appfooter .nowPlayingBar') : null;
            var footer = bar && bar.closest('.appfooter');
            inset = JellybutterCore.barInset(bar ? bar.className : null, footer ? footer.offsetHeight : 0);
        }
        if (inset === state.barInset) { return; }
        state.barInset = inset;
        ui.overlay.style.setProperty('--jellybutter-bar', inset + 'px');
        // The lyrics view ends at the bar, so its height just changed.
        if (state.lyricsOn) { updateLyrics(true); }
    }

    // jellyfin-web never builds its bar in the TV layout (its module returns early there), so on a TV the
    // visualizer shows a bar of its own, driven through jellyfin-web's Media Session handlers. The same bar,
    // stripped down by the ui-hidden styles, stands in for jellyfin-web's in every layout while the UI is
    // hidden: jellyfin-web's bar cannot drop its buttons and background.
    function isTvLayout() {
        return document.documentElement.classList.contains('layout-tv');
    }

    /** Puts up the bar the current state calls for (own, jellyfin-web's or none) and takes down the other. */
    function applyBar() {
        var want = config.nowPlayingBar && state.open;
        var own = want && (isTvLayout() || state.uiHidden);
        var web = want && !own;
        if (own !== state.ownBar) {
            state.ownBar = own;
            ui.overlay.classList.toggle('jellybutter-tvbar-on', own);
            if (own) {
                ui.tvPrev.hidden = !mediaActions.previoustrack;
                ui.tvRewind.hidden = !mediaActions.seekbackward;
                ui.tvForward.hidden = !mediaActions.seekforward;
                ui.tvNext.hidden = !mediaActions.nexttrack;
                state.barMeta = undefined;
                state.barPaused = null;
                state.barTime = null;
                state.barFraction = -1;
                updateTvBar();
            }
        }
        if (web !== state.webBar) {
            state.webBar = web;
            document.documentElement.classList.toggle('jellybutter-bar', web);
            tellBar(JellybutterCore.mediaControlFor(web, true, state.pageMediaControl));
            if (web) {
                // jellyfin-web builds the bar on first show and toggles its classes as playback changes.
                var footer = document.querySelector('.appfooter');
                if (footer && !state.barObserver) {
                    state.barObserver = new MutationObserver(updateBarInset);
                    state.barObserver.observe(footer, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
                }
            } else if (state.barObserver) {
                state.barObserver.disconnect();
                state.barObserver = null;
            }
        }
        updateBarInset();
    }

    /**
     * Hides or shows the UI over the visualizer: its controls, the bar's buttons and background, the preset
     * name and the lyrics badge. The track, artwork, time and progress stay.
     */
    function setUiHidden(hidden) {
        state.uiHidden = !!hidden;
        ui.overlay.classList.toggle('jellybutter-ui-hidden', state.uiHidden);
        if (state.uiHidden) {
            clearTimeout(controlsTimer);
            ui.overlay.classList.remove('jellybutter-controls-shown');
        }
        applyBar();
    }

    /** Runs one of jellyfin-web's Media Session handlers; false when it registered none for the action. */
    function mediaAction(action) {
        var handler = mediaActions[action];
        if (!handler) { return false; }
        try { handler({ action: action }); } catch (e) { console.error('[Jellybutter] media action ' + action + ' failed', e); }
        return true;
    }

    function playPause() {
        var audio = state.audio;
        if (!audio) { return; }
        if (mediaAction(audio.paused ? 'play' : 'pause')) { return; }
        // No handler (a browser without Media Session): the element itself, which jellyfin-web follows.
        if (audio.paused) {
            var started = audio.play();
            if (started && typeof started.catch === 'function') { started.catch(noop); }
        } else {
            audio.pause();
        }
    }

    /** Brings the TV bar up to date; cheap enough for every frame, it writes only what changed. */
    function updateTvBar() {
        var session = navigator.mediaSession;
        var meta = session ? session.metadata : null;
        if (meta !== state.barMeta) {
            state.barMeta = meta;
            ui.tvTitle.textContent = (meta && meta.title) || '';
            ui.tvSub.textContent = JellybutterCore.trackSubtitle(meta && meta.artist, meta && meta.album);
            var art = meta ? JellybutterCore.pickArtwork(meta.artwork) : null;
            ui.tvArt.hidden = !art;
            if (art && ui.tvArt.getAttribute('src') !== art) { ui.tvArt.src = art; }
        }
        var audio = state.audio;
        var paused = !audio || audio.paused;
        if (paused !== state.barPaused) {
            state.barPaused = paused;
            ui.tvPlay.innerHTML = icon(paused ? ICONS.play : ICONS.pause);
            ui.tvPlay.title = paused ? 'Play' : 'Pause';
            ui.tvPlay.setAttribute('aria-label', ui.tvPlay.title);
        }
        var current = audio ? audio.currentTime : NaN;
        var duration = audio ? audio.duration : NaN;
        var known = isFinite(duration) && duration > 0;
        var time = JellybutterCore.formatTime(current) + (known ? ' / ' + JellybutterCore.formatTime(duration) : '');
        if (time !== state.barTime) {
            state.barTime = time;
            ui.tvTime.textContent = time;
        }
        var fraction = known ? Math.min(1, Math.max(0, current / duration)) : 0;
        if (Math.abs(fraction - state.barFraction) >= 0.001) {
            state.barFraction = fraction;
            ui.tvFill.style.transform = 'scaleX(' + fraction + ')';
        }
    }

    // ---- D-pad navigation ----------------------------------------------------------------------------------

    // While the visualizer is open it owns the arrow, select and back keys, from the keyboard, a remote or a
    // gamepad: jellyfin-web's own focus navigation would walk into the page under the overlay. Focus moves
    // among the visualizer's buttons and the Now Playing bar's (jellyfin-web's, or the TV bar).
    function focusables() {
        var list = Array.prototype.slice.call(ui.overlay.querySelectorAll('button'));
        if (state.webBar) {
            list = list.concat(Array.prototype.slice.call(document.querySelectorAll('.appfooter .nowPlayingBar button')));
        }
        return list.filter(function (b) { return !b.disabled && b.getClientRects().length > 0; });
    }

    function defaultFocus() {
        return state.ownBar ? ui.tvPlay : ui.next;
    }

    function onNav(nav) {
        // Back hides the UI first, and closes from there: the page underneath is where it was opened from.
        if (nav === 'back') {
            if (state.uiHidden) { close(); } else { setUiHidden(true); }
            return;
        }
        if (state.uiHidden) {
            // Any other key only brings the UI back, with focus where a first press would put it.
            setUiHidden(false);
            showControls();
            var first = defaultFocus();
            if (first && focusables().indexOf(first) >= 0) { first.focus({ preventScroll: true }); }
            return;
        }
        var wasShown = controlsShown();
        showControls();
        var items = focusables();
        var current = document.activeElement;
        var index = items.indexOf(current);
        if (index < 0) {
            var start = defaultFocus();
            if (items.indexOf(start) >= 0) { start.focus({ preventScroll: true }); }
            return;
        }
        // The first press after the controls faded only brings them back: the focused one was invisible.
        if (!wasShown && ui.controls.contains(current)) { return; }
        if (nav === 'select') { current.click(); return; }
        var next = JellybutterCore.nextFocusIndex(current.getBoundingClientRect(), items.map(function (b) { return b.getBoundingClientRect(); }), nav);
        if (next >= 0) { items[next].focus({ preventScroll: true }); }
    }

    // ---- Open / close --------------------------------------------------------------------------------------

    var opening = false;

    /**
     * Opens the visualizer. `options.idle` is the idle timer opening it with no key press behind it: then it
     * only goes ahead when the element can be tapped without starting an AudioContext, or a context of its
     * own does start (the page had a gesture before), since routing the element into a context that stays
     * suspended would silence the music. It opens with the UI hidden when the idle setting says so.
     */
    function open(options) {
        var idle = !!(options && options.idle);
        if (state.open || opening || !state.audio || state.unsupported) { return; }
        if (!idle) { openNow(false); return; }
        opening = true;
        contextCanRun().then(function (ok) {
            opening = false;
            if (!ok) {
                console.info('[Jellybutter] idle visualizer skipped: no audio context can start without a key press yet');
                return;
            }
            openNow(config.idleHideUi);
        });
    }

    /** Whether the element is tapped already or a context of the script's own can run without a gesture. */
    function contextCanRun() {
        var audio = state.audio;
        if (!audio || taps.get(audio)) { return Promise.resolve(!!audio); }
        if (!state.ownContext) {
            var Ctor = window.AudioContext || window.webkitAudioContext;
            state.ownContext = new Ctor();
        }
        var context = state.ownContext;
        if (context.state === 'running') { return Promise.resolve(true); }
        // resume() settles only once the browser lets the context start; a page without a gesture yet
        // leaves it pending, so give up after a moment.
        return Promise.race([
            context.resume().then(function () { return context.state === 'running'; }, function () { return false; }),
            new Promise(function (resolve) { setTimeout(function () { resolve(context.state === 'running'); }, 1000); })
        ]);
    }

    function openNow(hideUi) {
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
            document.documentElement.classList.add('jellybutter-open');
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
            setUiHidden(hideUi);
            setLyrics(config.defaultView === 'lyrics');
            render();
            refreshButtons();
            if (!hideUi) {
                showControls();
                moveFocus(defaultFocus());
            }
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
        document.documentElement.classList.remove('jellybutter-open');
        ui.toggle.setAttribute('aria-pressed', 'false');
        setUiHidden(false);
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

    /** Acts on a navigation from a key or a command when the visualizer owns it; false leaves it to the page. */
    function takeNav(nav) {
        if (!nav || !ui.overlay) { return false; }
        if (state.open) { onNav(nav); return true; }
        return (nav === 'left' || nav === 'right') && rowArrow(nav);
    }

    /** jellyfin-web's input commands (see addInputPlugin): cancelled, the page's handling never runs. */
    function onCommand(e) {
        noteInput();
        if (e.defaultPrevented) { return; }
        var t = e.target;
        if (t && JellybutterCore.isTypingTarget(t.tagName, t.isContentEditable)) { return; }
        if (takeNav(JellybutterCore.navCommandFor(e.detail && e.detail.command))) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    function onKeyDown(e) {
        if (e.defaultPrevented) { return; }
        var t = e.target;
        if (t && JellybutterCore.isTypingTarget(t.tagName, t.isContentEditable)) { return; }
        if (takeNav(JellybutterCore.navKeyFor(e.key, e.keyCode, e))) {
            // Prevented, so neither jellyfin-web's navigation, the browser's own activation of a focused
            // button, nor jellyfin-web's click on releasing gamepad A acts on it a second time.
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
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

    // ---- Idle visualizer ------------------------------------------------------------------------------------

    var lastInput = Date.now();
    var IDLE_CHECK_MS = 5000;

    function noteInput() {
        lastInput = Date.now();
    }

    function checkIdle() {
        var due = JellybutterCore.shouldIdleOpen(config, {
            open: state.open,
            opening: opening,
            unsupported: state.unsupported,
            playing: JellybutterCore.isPlaying(state.audio),
            hidden: document.hidden,
            idleMs: Date.now() - lastInput
        });
        if (!due) { return; }
        // Counted as input, so a try that cannot open waits another idle period instead of every check.
        noteInput();
        open({ idle: true });
    }

    function startIdle() {
        // Gamepads reach the page as key events (jellyfin-web's gamepad translation, or Steam Input), or on
        // Jellyfin Desktop as input commands, which onCommand counts.
        ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'].forEach(function (ev) {
            window.addEventListener(ev, noteInput, { capture: true, passive: true });
        });
        setInterval(checkIdle, IDLE_CHECK_MS);
    }

    function start() {
        buildUi();
        startObserver();
        startIdle();
        // A read-only handle for diagnosing a client in the field (devtools, or a remote-debugging port).
        window.jellybutter = { version: version, config: config, core: JellybutterCore, state: state };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
