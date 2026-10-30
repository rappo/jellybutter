'use strict';

// The release zip ships THIRD-PARTY-NOTICES.txt because the DLL embeds the Butterchurn bundles, whose MIT
// license asks for its notice in every copy. These checks fail when a package is upgraded or added to the
// embedded set without its notice following.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
const EMBEDDED = ['butterchurn', 'butterchurn-presets'];

for (const name of EMBEDDED) {
    test(`notices: ${name} at the installed version, with its license text verbatim`, () => {
        const dir = path.join(root, 'node_modules', name);
        const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        assert.ok(notices.includes(`${name} ${version} (`), `no "${name} ${version}" heading`);
        const license = fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim();
        assert.ok(notices.includes(license), `${name}'s LICENSE is not reproduced exactly`);
    });
}

test('notices: every bundle the csproj embeds comes from a package listed here', () => {
    const csproj = fs.readFileSync(path.join(root, 'Jellyfin.Plugin.Jellybutter', 'Jellyfin.Plugin.Jellybutter.csproj'), 'utf8');
    const packages = [...csproj.matchAll(/node_modules\\([^\\]+)\\/g)].map((m) => m[1]);
    assert.ok(packages.length > 0);
    for (const p of packages) { assert.ok(EMBEDDED.includes(p), `${p} is embedded but has no notice`); }
});
