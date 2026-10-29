// The pure helpers of the client script, run under node:test. The script exports them when loaded outside a
// browser and skips its DOM part.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../Jellyfin.Plugin.Jellybutter/Web/jellybutter.js');

const DEFAULTS = { desktopWebAudio: true, cycleSeconds: 30, blendSeconds: 2.7, controlButton: true, floatingButton: true, nowPlayingBar: true, defaultView: 'visualizer', lyricsSize: 'medium' };

test('parseConfig: fills defaults for a missing, malformed or partial attribute', () => {
    assert.deepEqual(core.parseConfig(null), DEFAULTS);
    assert.deepEqual(core.parseConfig('not json'), DEFAULTS);
    assert.deepEqual(core.parseConfig('{"cycleSeconds":0}'), { ...DEFAULTS, cycleSeconds: 0 });
    assert.deepEqual(core.parseConfig('{"desktopWebAudio":false,"cycleSeconds":45,"blendSeconds":1.5,"controlButton":false,"floatingButton":false,"nowPlayingBar":false,"defaultView":"lyrics","lyricsSize":"large"}'),
        { desktopWebAudio: false, cycleSeconds: 45, blendSeconds: 1.5, controlButton: false, floatingButton: false, nowPlayingBar: false, defaultView: 'lyrics', lyricsSize: 'large' });
    assert.equal(core.parseConfig('{"cycleSeconds":-5,"blendSeconds":"x"}').cycleSeconds, 30);
    assert.equal(core.parseConfig('{"cycleSeconds":-5,"blendSeconds":"x"}').blendSeconds, 2.7);
    // Unknown choices fall back; casing is forgiven.
    assert.equal(core.parseConfig('{"defaultView":"karaoke"}').defaultView, 'visualizer');
    assert.equal(core.parseConfig('{"defaultView":"Lyrics"}').defaultView, 'lyrics');
    assert.equal(core.parseConfig('{"lyricsSize":"huge"}').lyricsSize, 'medium');
    assert.equal(core.parseConfig('{"controlButton":"no"}').controlButton, true);
    // A tag from 1.1.0.0, before the setting existed, gets the bar.
    assert.equal(core.parseConfig('{"controlButton":true}').nowPlayingBar, true);
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

test('hotkeyFor: v toggles while a track is loaded or the overlay is open; b, n, l and Escape only while open', () => {
    assert.equal(core.hotkeyFor('l', true, true), 'lyrics');
    assert.equal(core.hotkeyFor('L', true, false), 'lyrics');
    assert.equal(core.hotkeyFor('l', false, true), null);
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
    assert.equal(core.assetBase('http://h/Jellybutter/client.js?v=1.2.3.4'), 'http://h/Jellybutter/');
    assert.equal(core.assetBase('http://h/jellyfin/Jellybutter/client.js'), 'http://h/jellyfin/Jellybutter/');
    assert.equal(core.assetBase(undefined), null);
    assert.equal(core.assetBase('client.js'), null);
    assert.equal(core.assetUrl('http://h/Jellybutter/', 'butterchurn.js', '1.0.0.0'), 'http://h/Jellybutter/butterchurn.js?v=1.0.0.0');
    assert.equal(core.assetUrl('/Jellybutter/', 'butterchurn-presets.js', 'a b'), '/Jellybutter/butterchurn-presets.js?v=a%20b');
});

test('mergeAudioProfile: audio entries come from the browser, everything else stays the shell\'s', () => {
    // Shapes as seen in Jellyfin Desktop 2.0.0 and jellyfin-web 12.2: the shell's audio transcoding entry has
    // no Container or Context, which is what crashed jellyfin-web's universal-audio URL builder.
    const shell = {
        Name: 'Jellyfin Desktop', MaxStaticBitrate: 1e9,
        DirectPlayProfiles: [{ Type: 'Audio' }, { Type: 'Photo' }, { Type: 'Video' }],
        TranscodingProfiles: [{ Type: 'Audio' }, { Type: 'Video', Container: 'ts', Protocol: 'hls' }, { Type: 'Photo', Container: 'jpeg' }],
        CodecProfiles: [{ Type: 'Video' }],
        SubtitleProfiles: [{ Format: 'srt' }]
    };
    const browser = {
        DirectPlayProfiles: [{ Type: 'Audio', Container: 'mp3,flac,ogg' }, { Type: 'Video', Container: 'mp4' }],
        TranscodingProfiles: [{ Type: 'Audio', Container: 'mp3', Context: 'Streaming', AudioCodec: 'mp3', Protocol: 'http' }, { Type: 'Video', Container: 'ts', Context: 'Streaming' }],
        CodecProfiles: [{ Type: 'Audio', Codec: 'flac' }, { Type: 'VideoAudio', Codec: 'aac' }]
    };
    const merged = core.mergeAudioProfile(shell, browser);
    assert.deepEqual(merged.DirectPlayProfiles, [{ Type: 'Photo' }, { Type: 'Video' }, { Type: 'Audio', Container: 'mp3,flac,ogg' }]);
    assert.deepEqual(merged.TranscodingProfiles, [{ Type: 'Video', Container: 'ts', Protocol: 'hls' }, { Type: 'Photo', Container: 'jpeg' }, { Type: 'Audio', Container: 'mp3', Context: 'Streaming', AudioCodec: 'mp3', Protocol: 'http' }]);
    assert.deepEqual(merged.CodecProfiles, [{ Type: 'Video' }, { Type: 'Audio', Codec: 'flac' }]);
    assert.equal(merged.Name, 'Jellyfin Desktop');
    assert.equal(merged.MaxStaticBitrate, 1e9);
    assert.deepEqual(merged.SubtitleProfiles, [{ Format: 'srt' }]);
    // The shell's object is not mutated.
    assert.equal(shell.TranscodingProfiles.length, 3);
    assert.equal(shell.TranscodingProfiles[0].Type, 'Audio');
    // jellyfin-web's builder would now find an audio Streaming transcoding profile.
    assert.ok(merged.TranscodingProfiles.some((p) => p.Type === 'Audio' && p.Context === 'Streaming'));
});

test('mergeAudioProfile: without a browser profile or a shell profile, the shell profile is returned as is', () => {
    const shell = { DirectPlayProfiles: [{ Type: 'Audio' }] };
    assert.equal(core.mergeAudioProfile(shell, null), shell);
    assert.equal(core.mergeAudioProfile(shell, undefined), shell);
    assert.equal(core.mergeAudioProfile(null, { DirectPlayProfiles: [] }), null);
    // Missing arrays on either side are tolerated.
    assert.deepEqual(core.mergeAudioProfile({}, {}).TranscodingProfiles, []);
});

test('buttonPlacement: the row button on the Now Playing page, the floating button elsewhere', () => {
    const both = { controlButton: true, floatingButton: true };
    assert.deepEqual(core.buttonPlacement(both, true, false, true), { control: true, floating: false });
    assert.deepEqual(core.buttonPlacement(both, true, false, false), { control: false, floating: true });
    // No track, or a browser without WebGL 2: nothing.
    assert.deepEqual(core.buttonPlacement(both, false, false, true), { control: false, floating: false });
    assert.deepEqual(core.buttonPlacement(both, true, true, true), { control: false, floating: false });
    // The row button switched off: the floating one covers the Now Playing page too.
    assert.deepEqual(core.buttonPlacement({ controlButton: false, floatingButton: true }, true, false, true), { control: false, floating: true });
    // The floating button switched off: nothing outside the Now Playing page.
    assert.deepEqual(core.buttonPlacement({ controlButton: true, floatingButton: false }, true, false, false), { control: false, floating: false });
    assert.deepEqual(core.buttonPlacement({ controlButton: true, floatingButton: false }, true, false, true), { control: true, floating: false });
    assert.deepEqual(core.buttonPlacement(null, true, false, true), { control: false, floating: false });
});

test('controlButtonIndex: after Lyrics, else before Shuffle, else at the end', () => {
    // jellyfin-web 12.2's row: favorite, lyrics, shuffle, repeat.
    const row = ['btnUserRating autoSize', 'btnLyrics autoSize hide', 'btnShuffleQueue autoSize', 'btnCommand btnRepeat repeatToggleButton autoSize'];
    assert.equal(core.controlButtonIndex(row), 2);
    assert.equal(core.controlButtonIndex(['btnUserRating', 'btnShuffleQueue', 'btnRepeat']), 1);
    assert.equal(core.controlButtonIndex(['btnUserRating', 'btnRepeat']), 2);
    assert.equal(core.controlButtonIndex([]), 0);
    assert.equal(core.controlButtonIndex(undefined), 0);
    // Whole class names only.
    assert.equal(core.controlButtonIndex(['btnLyricsX', 'btnShuffleQueueMobile']), 2);
});

test('itemIdFromSrc: the item id out of jellyfin-web\'s audio URLs', () => {
    const id = '8afcd5e1f7644a56851bdb0aac469b10';
    assert.equal(core.itemIdFromSrc('http://h/Audio/' + id + '/universal?UserId=x&DeviceId=y&api_key=z'), id);
    assert.equal(core.itemIdFromSrc('http://h/jellyfin/Audio/' + id + '/stream.flac?Static=true'), id);
    assert.equal(core.itemIdFromSrc('/Audio/8AFCD5E1-F764-4A56-851B-DB0AAC469B10/universal'), id);
    assert.equal(core.itemIdFromSrc('http://h/Videos/' + id + '/stream'), null);
    assert.equal(core.itemIdFromSrc('http://h/Audio/notanid/universal'), null);
    assert.equal(core.itemIdFromSrc(''), null);
    assert.equal(core.itemIdFromSrc(undefined), null);
});

test('normalizeLyrics: synced lines sorted by time in seconds, unsynced as a block, nothing when empty', () => {
    const synced = core.normalizeLyrics({ Metadata: {}, Lyrics: [{ Start: 125000000, Text: 'second' }, { Start: 0, Text: 'first' }, { Start: 300000000, Text: '' }] });
    assert.deepEqual(synced, { synced: true, lines: [{ start: 0, text: 'first' }, { start: 12.5, text: 'second' }, { start: 30, text: '' }] });
    const plain = core.normalizeLyrics({ Lyrics: [{ Text: 'line one' }, { Text: ' line two ' }] });
    assert.deepEqual(plain, { synced: false, lines: [{ start: null, text: 'line one' }, { start: null, text: 'line two' }] });
    // A line without a time makes the whole lot unsynced rather than a jumping display.
    assert.equal(core.normalizeLyrics({ Lyrics: [{ Start: 0, Text: 'a' }, { Text: 'b' }] }).synced, false);
    assert.equal(core.normalizeLyrics({ Lyrics: [] }), null);
    assert.equal(core.normalizeLyrics({ Lyrics: [{ Text: '' }, { Start: 5, Text: '  ' }] }), null);
    assert.equal(core.normalizeLyrics(null), null);
    assert.equal(core.normalizeLyrics({}), null);
    // Equal times keep their order.
    const tie = core.normalizeLyrics({ Lyrics: [{ Start: 10, Text: 'x' }, { Start: 10, Text: 'y' }] });
    assert.deepEqual(tie.lines.map((l) => l.text), ['x', 'y']);
});

test('lyricIndexAt: the last line that has started, -1 before the first', () => {
    const lines = [{ start: 0.5 }, { start: 12.5 }, { start: 30 }];
    assert.equal(core.lyricIndexAt(lines, 0), -1);
    assert.equal(core.lyricIndexAt(lines, 0.5), 0);
    assert.equal(core.lyricIndexAt(lines, 12.49), 0);
    assert.equal(core.lyricIndexAt(lines, 12.5), 1);
    assert.equal(core.lyricIndexAt(lines, 1000), 2);
    assert.equal(core.lyricIndexAt([], 5), -1);
    assert.equal(core.lyricIndexAt(lines, NaN), -1);
    assert.equal(core.lyricIndexAt(undefined, 5), -1);
});

test('blockOffset: an unsynced block stays put while it fits and scrolls with progress when it does not', () => {
    assert.equal(core.blockOffset(400, 800, 0.5), 0);
    assert.equal(core.blockOffset(800, 800, 1), 0);
    assert.equal(core.blockOffset(1800, 800, 0), 0);
    assert.equal(core.blockOffset(1800, 800, 0.5), -500);
    assert.equal(core.blockOffset(1800, 800, 1), -1000);
    assert.equal(core.blockOffset(1800, 800, 7), -1000);
    assert.equal(core.blockOffset(1800, 800, -1), 0);
    assert.equal(core.blockOffset(1800, 800, NaN), 0);
});

test('mediaControlFor: the open visualizer allows the bar; closed, or with the setting off, the page decides', () => {
    assert.equal(core.mediaControlFor(true, true, false), true);     // opened from Now Playing, which hides it
    assert.equal(core.mediaControlFor(true, true, true), true);
    assert.equal(core.mediaControlFor(false, true, false), false);   // closing on Now Playing hands it back
    assert.equal(core.mediaControlFor(false, true, true), true);
    assert.equal(core.mediaControlFor(true, false, false), false);   // setting off: never overridden
    // No page seen yet: jellyfin-web starts out allowing it.
    assert.equal(core.mediaControlFor(false, true, null), true);
});

test('barInset: the footer height while the bar shows, nothing while it is missing, hidden or slid away', () => {
    assert.equal(core.barInset('nowPlayingBar', 74.6), 75);
    assert.equal(core.barInset('nowPlayingBar hide nowPlayingBar-hidden', 74), 0);   // as jellyfin-web first builds it
    assert.equal(core.barInset('nowPlayingBar nowPlayingBar-hidden', 74), 0);
    assert.equal(core.barInset('nowPlayingBar hide', 74), 0);
    assert.equal(core.barInset(null, 74), 0);                                         // TV layout: no bar at all
    assert.equal(core.barInset('nowPlayingBar', 0), 0);
    assert.equal(core.barInset('nowPlayingBar-hiddenish nowPlayingBar', 60), 60);    // whole class names only
});
