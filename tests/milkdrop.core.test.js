// The pure helpers of the client script, run under node:test. The script exports them when loaded outside a
// browser and skips its DOM part.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../Jellyfin.Plugin.Milkdrop/Web/milkdrop.js');

test('parseConfig: fills defaults for a missing, malformed or partial attribute', () => {
    assert.deepEqual(core.parseConfig(null), { desktopWebAudio: true, cycleSeconds: 30, blendSeconds: 2.7 });
    assert.deepEqual(core.parseConfig('not json'), { desktopWebAudio: true, cycleSeconds: 30, blendSeconds: 2.7 });
    assert.deepEqual(core.parseConfig('{"cycleSeconds":0}'), { desktopWebAudio: true, cycleSeconds: 0, blendSeconds: 2.7 });
    assert.deepEqual(core.parseConfig('{"desktopWebAudio":false,"cycleSeconds":45,"blendSeconds":1.5}'), { desktopWebAudio: false, cycleSeconds: 45, blendSeconds: 1.5 });
    assert.equal(core.parseConfig('{"cycleSeconds":-5,"blendSeconds":"x"}').cycleSeconds, 30);
    assert.equal(core.parseConfig('{"cycleSeconds":-5,"blendSeconds":"x"}').blendSeconds, 2.7);
});

test('filterNativePlugins: drops only the mpv audio player, only when the setting is on', () => {
    const desktop = ['mpvVideoPlayer', 'mpvAudioPlayer', 'inputPlugin', 'updatePlugin'];
    assert.deepEqual(core.filterNativePlugins(desktop, { desktopWebAudio: true }), ['mpvVideoPlayer', 'inputPlugin', 'updatePlugin']);
    assert.deepEqual(core.filterNativePlugins(desktop, { desktopWebAudio: false }), desktop);
    assert.deepEqual(core.filterNativePlugins(desktop, null), desktop);
    // A module path or URL naming the player is matched too.
    assert.deepEqual(core.filterNativePlugins(['plugins/mpvAudioPlayer/plugin.js', 'x'], { desktopWebAudio: true }), ['x']);
    // Non-string entries and non-lists pass through untouched.
    const fn = () => 1;
    assert.deepEqual(core.filterNativePlugins([fn, 'mpvAudioPlayer'], { desktopWebAudio: true }), [fn]);
    assert.equal(core.filterNativePlugins(undefined, { desktopWebAudio: true }), undefined);
    assert.equal(core.filterNativePlugins('mpvAudioPlayer', { desktopWebAudio: true }), 'mpvAudioPlayer');
});

test('stepIndex wraps in both directions and survives an empty list', () => {
    assert.equal(core.stepIndex(0, 5, 1), 1);
    assert.equal(core.stepIndex(4, 5, 1), 0);
    assert.equal(core.stepIndex(0, 5, -1), 4);
    assert.equal(core.stepIndex(7, 5, 0), 2);
    assert.equal(core.stepIndex(3, 0, 1), 0);
});

test('randomIndex never repeats the current preset when there is a choice', () => {
    for (let i = 0; i < 50; i++) {
        const pick = core.randomIndex(10, 3);
        assert.ok(pick >= 0 && pick < 10 && pick !== 3, `picked ${pick}`);
    }
    assert.equal(core.randomIndex(10, 3, () => 0.3), 2);     // 0.3 * 9 = 2.7 -> 2, below the current 3 so kept
    assert.equal(core.randomIndex(10, 3, () => 0.5), 5);     // 0.5 * 9 = 4.5 -> 4, at or past the current 3 so shifted up
    assert.equal(core.randomIndex(10, 0, () => 0), 1);
    assert.equal(core.randomIndex(1, 0), 0);
    assert.equal(core.randomIndex(0, 0), 0);
    // A current index of -1 (nothing loaded yet) allows every preset.
    assert.equal(core.randomIndex(10, -1, () => 0), 0);
});

test('hotkeyFor: v toggles while a track is loaded or the overlay is open; b, n and Escape only while open', () => {
    assert.equal(core.hotkeyFor('v', false, true), 'toggle');
    assert.equal(core.hotkeyFor('V', true, false), 'toggle');
    assert.equal(core.hotkeyFor('v', false, false), null);
    assert.equal(core.hotkeyFor('b', true, true), 'next');
    assert.equal(core.hotkeyFor('n', true, true), 'prev');
    assert.equal(core.hotkeyFor('Escape', true, true), 'close');
    assert.equal(core.hotkeyFor('b', false, true), null);
    assert.equal(core.hotkeyFor('Escape', false, true), null);
    assert.equal(core.hotkeyFor('x', true, true), null);
    assert.equal(core.hotkeyFor('v', true, true, { ctrlKey: true }), null);
    assert.equal(core.hotkeyFor(undefined, true, true), null);
});

test('isTypingTarget: fields and editable regions keep their keys', () => {
    assert.equal(core.isTypingTarget('INPUT', false), true);
    assert.equal(core.isTypingTarget('textarea', false), true);
    assert.equal(core.isTypingTarget('SELECT', false), true);
    assert.equal(core.isTypingTarget('DIV', true), true);
    assert.equal(core.isTypingTarget('DIV', false), false);
    assert.equal(core.isTypingTarget('BUTTON', false), false);
    assert.equal(core.isTypingTarget(undefined, undefined), false);
});

test('isTrackLoaded: playing or paused on a loaded source, never stopped or ended', () => {
    assert.equal(core.isTrackLoaded(null), false);
    assert.equal(core.isTrackLoaded({ paused: false, ended: false, currentSrc: 'x', readyState: 4 }), true);
    assert.equal(core.isTrackLoaded({ paused: true, ended: false, currentSrc: 'x', readyState: 1 }), true);
    assert.equal(core.isTrackLoaded({ paused: true, ended: false, currentSrc: '', readyState: 0 }), false);
    assert.equal(core.isTrackLoaded({ paused: true, ended: true, currentSrc: 'x', readyState: 4 }), false);
    assert.equal(core.isTrackLoaded({ paused: true, ended: false, currentSrc: 'x', readyState: 0 }), false);
});

test('assetBase and assetUrl: bundles resolve beside the script with the same version query', () => {
    assert.equal(core.assetBase('http://h/Milkdrop/client.js?v=1.2.3.4'), 'http://h/Milkdrop/');
    assert.equal(core.assetBase('http://h/jellyfin/Milkdrop/client.js'), 'http://h/jellyfin/Milkdrop/');
    assert.equal(core.assetBase(undefined), null);
    assert.equal(core.assetBase('client.js'), null);
    assert.equal(core.assetUrl('http://h/Milkdrop/', 'butterchurn.js', '1.0.0.0'), 'http://h/Milkdrop/butterchurn.js?v=1.0.0.0');
    assert.equal(core.assetUrl('/Milkdrop/', 'butterchurn-presets.js', 'a b'), '/Milkdrop/butterchurn-presets.js?v=a%20b');
});
