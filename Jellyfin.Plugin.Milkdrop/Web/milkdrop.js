/*
 * Milkdrop Visualizer for Jellyfin: a Butterchurn (MilkDrop 2, WebGL) visualizer for jellyfin-web.
 *
 * Loaded by the script tag the plugin adds to index.html. Plain JavaScript, no framework, no build step.
 * The tag's data-config attribute carries the plugin settings as JSON. The script:
 *
 *   - On Jellyfin Desktop, wraps NativeShell.getPlugins so music plays through the web player (an <audio>
 *     element Web Audio can hear) instead of mpv, when the setting says so. Video stays on mpv. This runs
 *     synchronously at load, before jellyfin-web's deferred bundles ask the shell for its plugins.
 *   - Watches for jellyfin-web's <audio> element and shows a floating toggle button while a track is loaded.
 *     The button sits inside a positioned wrapper because jellyfin-web's arrow-key (D-pad) focus manager
 *     skips any element whose offsetParent is null, which a fixed-position element's always is.
 *   - On first open, builds the Web Audio graph once per element (source -> analyser -> destination; the
 *     element's output can only be captured once) and lazy-loads the two Butterchurn bundles from the
 *     plugin, then renders full screen with a random starting preset, auto-cycling, blended changes and
 *     a preset-name flash.
 *   - Hotkeys: v toggles the visualizer, b next preset, n previous preset, Escape closes. Ignored while
 *     typing in a field.
 *
 * The pure helpers live on MilkdropCore and are exported for the node:test suite under tests/; the DOM
 * part only runs in a browser.
 */
(function () {
    'use strict';

    var DEFAULTS = { desktopWebAudio: true, cycleSeconds: 30, blendSeconds: 2.7 };
    var NAME_FLASH_MS = 3000;
    var STOP_GRACE_MS = 1500;

    var MilkdropCore = {
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
            return {
                desktopWebAudio: typeof parsed.desktopWebAudio === 'boolean' ? parsed.desktopWebAudio : DEFAULTS.desktopWebAudio,
                cycleSeconds: isFinite(cycle) && cycle >= 0 ? cycle : DEFAULTS.cycleSeconds,
                blendSeconds: isFinite(blend) && blend >= 0 ? blend : DEFAULTS.blendSeconds
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
         * Maps a key to an action given the current state: 'toggle', 'next', 'prev', 'close' or null.
         * The toggle only works while a track is loaded (there is nothing to visualize otherwise); the
         * others only while the visualizer is open. Modifier combinations are left to the browser.
         */
        hotkeyFor: function (key, open, trackLoaded, modifiers) {
            if (modifiers && (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey)) { return null; }
            var k = (key || '').toLowerCase();
            if (k === 'v') { return open || trackLoaded ? 'toggle' : null; }
            if (!open) { return null; }
            if (k === 'escape') { return 'close'; }
            if (k === 'b') { return 'next'; }
            if (k === 'n') { return 'prev'; }
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
        module.exports = MilkdropCore;
    }
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }

    // ---- Runtime ----------------------------------------------------------------------------------------

    var scriptEl = document.currentScript;
    var config = MilkdropCore.parseConfig(scriptEl && scriptEl.getAttribute('data-config'));
    var scriptSrc = scriptEl && scriptEl.src;
    var version = (function () {
        var m = /[?&]v=([^&]*)/.exec(scriptSrc || '');
        return m ? decodeURIComponent(m[1]) : '';
    })();
    var assetBase = MilkdropCore.assetBase(scriptSrc) || 'Milkdrop/';

    // Jellyfin Desktop: must run now, before jellyfin-web's deferred bundles load its plugins.
    (function patchNativeShell() {
        var shell = window.NativeShell;
        if (!shell || typeof shell.getPlugins !== 'function' || shell.__milkdropWrapped) { return; }
        var original = shell.getPlugins;
        shell.getPlugins = function () {
            var list = original.apply(this, arguments);
            if (list && typeof list.then === 'function') {
                return list.then(function (resolved) { return MilkdropCore.filterNativePlugins(resolved, config); });
            }
            return MilkdropCore.filterNativePlugins(list, config);
        };
        shell.__milkdropWrapped = true;
        if (config.desktopWebAudio) {
            console.info('[Milkdrop] Jellyfin Desktop: music will play through the web player so the visualizer can hear it.');
        }
    })();

    var state = {
        audio: null,            // the <audio> element being watched
        context: null,          // the one AudioContext
        sources: null,          // WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>
        source: null,           // the source node of state.audio
        visualizer: null,
        presets: null,          // { [name]: preset }
        names: [],              // sorted preset names
        index: 0,
        open: false,
        raf: 0,
        cycleTimer: 0,
        flashTimer: 0,
        stopTimer: 0,
        libs: null,             // Promise for the bundles
        lastFocus: null
    };

    var ui = {};

    function css() {
        var style = document.createElement('style');
        style.id = 'milkdrop-style';
        style.textContent = [
            '.milkdrop-toggle-wrap{position:fixed;right:1.5em;bottom:6.5em;z-index:9998;display:none}',
            '.milkdrop-toggle-wrap.milkdrop-visible{display:block}',
            '.milkdrop-toggle{width:3em;height:3em;border-radius:50%;border:none;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 .15em .8em rgba(0,0,0,.5);transition:background .2s,transform .15s;padding:0}',
            '.milkdrop-toggle:hover,.milkdrop-toggle:focus{background:rgba(0,164,220,.85);outline:none;transform:scale(1.1)}',
            '.milkdrop-toggle:focus-visible{box-shadow:0 0 0 .2em #fff}',
            '.milkdrop-toggle svg{width:1.5em;height:1.5em}',
            '.milkdrop-overlay{position:fixed;inset:0;z-index:99999;background:#000;display:none}',
            '.milkdrop-overlay.milkdrop-open{display:block}',
            '.milkdrop-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
            '.milkdrop-toast{position:absolute;top:1em;left:1em;padding:.5em .9em;background:rgba(0,0,0,.55);color:#fff;border-radius:.5em;font:600 .95em/1.3 sans-serif;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .3s}',
            '.milkdrop-toast.milkdrop-shown{opacity:1}',
            '.milkdrop-toast small{display:block;font-weight:400;font-size:.75em;color:rgba(255,255,255,.55)}',
            '.milkdrop-controls{position:absolute;right:1em;bottom:1em;display:flex;gap:.3em;opacity:0;transition:opacity .3s}',
            '.milkdrop-overlay:hover .milkdrop-controls,.milkdrop-controls:focus-within,.milkdrop-overlay.milkdrop-controls-shown .milkdrop-controls{opacity:1}',
            '.milkdrop-ctrl{width:2.4em;height:2.4em;border:none;border-radius:50%;background:rgba(0,0,0,.5);color:rgba(255,255,255,.85);font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
            '.milkdrop-ctrl:hover,.milkdrop-ctrl:focus{background:rgba(0,164,220,.85);color:#fff;outline:none}',
            '.milkdrop-ctrl:focus-visible{box-shadow:0 0 0 .2em #fff}',
            '.milkdrop-ctrl svg{width:1.2em;height:1.2em}'
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
        ui.toggleWrap.className = 'milkdrop-toggle-wrap';
        ui.toggle = button('milkdrop-toggle', 'Visualizer (v)', ICONS.bars, toggle);
        ui.toggle.setAttribute('aria-pressed', 'false');
        ui.toggleWrap.appendChild(ui.toggle);
        document.body.appendChild(ui.toggleWrap);

        ui.overlay = document.createElement('div');
        ui.overlay.className = 'milkdrop-overlay';
        ui.overlay.setAttribute('role', 'dialog');
        ui.overlay.setAttribute('aria-label', 'Music visualizer');
        ui.canvas = document.createElement('canvas');
        ui.canvas.className = 'milkdrop-canvas';
        ui.toast = document.createElement('div');
        ui.toast.className = 'milkdrop-toast';
        ui.toast.setAttribute('aria-live', 'polite');
        ui.controls = document.createElement('div');
        ui.controls.className = 'milkdrop-controls';
        ui.prev = button('milkdrop-ctrl', 'Previous preset (n)', ICONS.prev, function () { loadPreset(MilkdropCore.stepIndex(state.index, state.names.length, -1)); });
        ui.random = button('milkdrop-ctrl', 'Random preset', ICONS.random, function () { loadPreset(MilkdropCore.randomIndex(state.names.length, state.index)); });
        ui.next = button('milkdrop-ctrl', 'Next preset (b)', ICONS.next, function () { loadPreset(MilkdropCore.stepIndex(state.index, state.names.length, 1)); });
        ui.close = button('milkdrop-ctrl', 'Close visualizer (Escape)', ICONS.close, close);
        ui.controls.appendChild(ui.prev);
        ui.controls.appendChild(ui.random);
        ui.controls.appendChild(ui.next);
        ui.controls.appendChild(ui.close);
        ui.overlay.appendChild(ui.canvas);
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
        ui.overlay.classList.add('milkdrop-controls-shown');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(function () { ui.overlay.classList.remove('milkdrop-controls-shown'); }, 2500);
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
        state.source = null;
        if (audio) {
            audioEvents.forEach(function (ev) { audio.addEventListener(ev, onAudioEvent); });
            if (state.open) { connect(); }
        }
        onAudioEvent();
    }

    function onAudioEvent() {
        var loaded = MilkdropCore.isTrackLoaded(state.audio);
        if (loaded) {
            clearTimeout(state.stopTimer);
            state.stopTimer = 0;
            ui.toggleWrap.classList.add('milkdrop-visible');
            return;
        }
        // Between tracks jellyfin-web empties and reloads the same element within a moment; only a stop that
        // lasts closes the visualizer and hides the button.
        if (!state.stopTimer) {
            state.stopTimer = setTimeout(function () {
                state.stopTimer = 0;
                if (MilkdropCore.isTrackLoaded(state.audio)) { return; }
                ui.toggleWrap.classList.remove('milkdrop-visible');
                if (state.open) { close(); }
            }, STOP_GRACE_MS);
        }
    }

    function startObserver() {
        watch(findAudio());
        var observer = new MutationObserver(function () {
            var audio = findAudio();
            if (audio !== state.audio) { watch(audio); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---- Web Audio ----------------------------------------------------------------------------------------

    function ensureContext() {
        if (!state.context) {
            var Ctor = window.AudioContext || window.webkitAudioContext;
            state.context = new Ctor();
            state.sources = new WeakMap();
        }
        if (state.context.state === 'suspended') {
            state.context.resume().catch(function () { /* resumed on the next gesture */ });
        }
        return state.context;
    }

    /** Routes the current element through the graph once; a second call for the same element reuses it. */
    function connect() {
        var audio = state.audio;
        if (!audio) { return null; }
        var ctx = ensureContext();
        var source = state.sources.get(audio);
        if (!source) {
            source = ctx.createMediaElementSource(audio);
            var analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            analyser.connect(ctx.destination);
            state.sources.set(audio, source);
        }
        if (state.source !== source) {
            if (state.visualizer && state.source) {
                try { state.visualizer.disconnectAudio(state.source); } catch (e) { /* already gone */ }
            }
            state.source = source;
            if (state.visualizer) { state.visualizer.connectAudio(source); }
        }
        return source;
    }

    // ---- Butterchurn ---------------------------------------------------------------------------------------

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Milkdrop: failed to load ' + url)); };
            document.head.appendChild(s);
        });
    }

    function ensureLibs() {
        if (!state.libs) {
            state.libs = Promise.all([
                window.butterchurn ? Promise.resolve() : loadScript(MilkdropCore.assetUrl(assetBase, 'butterchurn.js', version)),
                window.butterchurnPresets ? Promise.resolve() : loadScript(MilkdropCore.assetUrl(assetBase, 'butterchurn-presets.js', version))
            ]).then(function () {
                if (!window.butterchurn || !window.butterchurnPresets) { throw new Error('Milkdrop: Butterchurn did not define itself'); }
                state.presets = window.butterchurnPresets.getPresets();
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

    function createVisualizer() {
        var v = viewport();
        ui.canvas.width = Math.round(v.w * v.dpr);
        ui.canvas.height = Math.round(v.h * v.dpr);
        state.visualizer = window.butterchurn.createVisualizer(state.context, ui.canvas, {
            width: v.w,
            height: v.h,
            pixelRatio: v.dpr,
            textureRatio: 1
        });
        if (state.source) { state.visualizer.connectAudio(state.source); }
    }

    function resize() {
        if (!state.open || !state.visualizer) { return; }
        var v = viewport();
        ui.canvas.width = Math.round(v.w * v.dpr);
        ui.canvas.height = Math.round(v.h * v.dpr);
        state.visualizer.setRendererSize(v.w, v.h, { pixelRatio: v.dpr, textureRatio: 1 });
    }

    function loadPreset(index, blend) {
        if (!state.visualizer || !state.names.length) { return; }
        state.index = MilkdropCore.stepIndex(index, state.names.length, 0);
        var name = state.names[state.index];
        state.visualizer.loadPreset(state.presets[name], typeof blend === 'number' ? blend : config.blendSeconds);
        ui.toast.textContent = '';
        ui.toast.appendChild(document.createTextNode(name));
        var counter = document.createElement('small');
        counter.textContent = (state.index + 1) + ' / ' + state.names.length;
        ui.toast.appendChild(counter);
        ui.toast.classList.add('milkdrop-shown');
        clearTimeout(state.flashTimer);
        state.flashTimer = setTimeout(function () { ui.toast.classList.remove('milkdrop-shown'); }, NAME_FLASH_MS);
        restartCycle();
    }

    function restartCycle() {
        clearInterval(state.cycleTimer);
        state.cycleTimer = 0;
        if (config.cycleSeconds > 0 && state.open) {
            state.cycleTimer = setInterval(function () {
                loadPreset(MilkdropCore.stepIndex(state.index, state.names.length, 1));
            }, config.cycleSeconds * 1000);
        }
    }

    function render() {
        if (!state.open || !state.visualizer) { state.raf = 0; return; }
        try { state.visualizer.render(); } catch (e) { console.error('[Milkdrop] render failed', e); close(); return; }
        state.raf = requestAnimationFrame(render);
    }

    // ---- Open / close --------------------------------------------------------------------------------------

    var opening = false;

    function open() {
        if (state.open || opening || !state.audio) { return; }
        opening = true;
        // The context is created inside the gesture, as autoplay policy requires.
        connect();
        ensureLibs().then(function () {
            opening = false;
            if (!state.audio) { return; }
            state.open = true;
            state.lastFocus = document.activeElement;
            ui.overlay.classList.add('milkdrop-open');
            ui.toggle.setAttribute('aria-pressed', 'true');
            if (!state.visualizer) { createVisualizer(); } else { resize(); }
            loadPreset(MilkdropCore.randomIndex(state.names.length, -1), 0);
            render();
            showControls();
            ui.next.focus({ preventScroll: true });
        }, function (err) {
            opening = false;
            console.error('[Milkdrop]', err);
        });
    }

    function close() {
        if (!state.open) { return; }
        state.open = false;
        cancelAnimationFrame(state.raf);
        state.raf = 0;
        clearInterval(state.cycleTimer);
        state.cycleTimer = 0;
        ui.overlay.classList.remove('milkdrop-open');
        ui.toggle.setAttribute('aria-pressed', 'false');
        var back = state.lastFocus;
        state.lastFocus = null;
        if (ui.toggleWrap.classList.contains('milkdrop-visible')) {
            ui.toggle.focus({ preventScroll: true });
        } else if (back && typeof back.focus === 'function' && document.contains(back)) {
            back.focus({ preventScroll: true });
        }
    }

    function toggle() {
        if (state.open) { close(); } else { open(); }
    }

    function onKeyDown(e) {
        if (e.defaultPrevented) { return; }
        var t = e.target;
        if (t && MilkdropCore.isTypingTarget(t.tagName, t.isContentEditable)) { return; }
        var action = MilkdropCore.hotkeyFor(e.key, state.open, MilkdropCore.isTrackLoaded(state.audio), e);
        if (!action) { return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (action === 'toggle') { toggle(); }
        else if (action === 'close') { close(); }
        else if (action === 'next') { loadPreset(MilkdropCore.stepIndex(state.index, state.names.length, 1)); }
        else if (action === 'prev') { loadPreset(MilkdropCore.stepIndex(state.index, state.names.length, -1)); }
    }

    function start() {
        buildUi();
        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
