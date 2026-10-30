'use strict';

// Loads the client script as Jellyfin Desktop would, with a stand-in NativeShell, to check that the
// visualizer lists its input plugin and that the plugin registers with jellyfin-web's inputManager.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Jellyfin.Plugin.Jellybutter/Web/jellybutter.js'), 'utf8');

function load(shell) {
    const listeners = [];
    const window = {
        NativeShell: shell,
        addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
        console: { info() {}, warn() {}, error() {}, debug() {} }
    };
    window.window = window;
    window.navigator = {};
    window.document = {
        readyState: 'loading',
        currentScript: { src: 'http://host/Jellybutter/client.js?v=1', getAttribute: () => null },
        addEventListener() {}
    };
    vm.runInNewContext(source, window);
    return { window, listeners };
}

test('Jellyfin Desktop: the input plugin is listed and registers for input commands', () => {
    const { window, listeners } = load({ getPlugins: () => ['mpvVideoPlayer', 'inputPlugin'] });

    const list = window.NativeShell.getPlugins();
    assert.ok(list.includes('jellybutterInputPlugin'));
    assert.ok(list.includes('inputPlugin'));

    const registered = [];
    const Plugin = window.jellybutterInputPlugin();
    const plugin = new Plugin({ inputManager: { on: (target) => registered.push(target) } });
    assert.equal(plugin.id, 'jellybutterInputPlugin');
    assert.deepEqual(registered, [window]);   // what makes jellyfin-web dispatch command events at all
    const command = listeners.find((l) => l.type === 'command');
    assert.ok(command && command.capture, 'a capture-phase command listener');

    // Closed and before the UI is built, commands are left to the page.
    let prevented = false;
    command.fn({ detail: { command: 'back' }, target: null, defaultPrevented: false, preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, false);
});

test('Jellyfin Desktop: an async plugin list gets the input plugin too', async () => {
    const { window } = load({ getPlugins: () => Promise.resolve(['inputPlugin']) });
    assert.deepEqual(await window.NativeShell.getPlugins(), ['inputPlugin', 'jellybutterInputPlugin']);
});

test('A browser (no NativeShell) gets no input plugin', () => {
    const { window } = load(undefined);
    assert.equal(window.jellybutterInputPlugin, undefined);
});
