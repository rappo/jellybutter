#!/usr/bin/env node
// Adds (or replaces) one version in manifest.json, the Jellyfin plugin-repository index. Zero dependencies.
//
//   node update-manifest.js <manifest.json> <meta.json> <zip path> <zip download url>
//
// The manifest is the file Jellyfin fetches from the repository URL; each entry's checksum is the zip's md5,
// which Jellyfin verifies after download. Versions are kept newest first; a version already listed is
// replaced, so a re-run after a failed upload leaves one entry per version.
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const [manifestPath, metaPath, zipPath, sourceUrl] = process.argv.slice(2);
if (!manifestPath || !metaPath || !zipPath || !sourceUrl) {
    console.error('usage: update-manifest.js <manifest.json> <meta.json> <zip> <url>');
    process.exit(2);
}

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const checksum = crypto.createHash('md5').update(fs.readFileSync(zipPath)).digest('hex');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];

let plugin = manifest.find((p) => p.guid === meta.guid);
if (!plugin) {
    plugin = { guid: meta.guid, versions: [] };
    manifest.push(plugin);
}
Object.assign(plugin, {
    name: meta.name,
    description: meta.description,
    overview: meta.overview,
    owner: meta.owner,
    category: meta.category,
    imageUrl: meta.imageUrl || '',
});

const entry = {
    version: meta.version,
    changelog: meta.changelog,
    targetAbi: meta.targetAbi,
    sourceUrl,
    checksum,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
plugin.versions = [entry, ...plugin.versions.filter((v) => v.version !== meta.version)];
plugin.versions.sort((a, b) => compareVersions(b.version, a.version));

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
console.log(`manifest: ${meta.name} ${meta.version} md5 ${checksum}`);

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}
