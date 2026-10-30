#!/usr/bin/env node
// Writes a ZIP archive (deflate) from files, with no dependencies: the shared CI runner image has no `zip`.
//   node make-zip.js <out.zip> <file> [<file>...]      entries are named by basename
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const [out, ...files] = process.argv.slice(2);
if (!out || files.length === 0) {
    console.error('usage: make-zip.js <out.zip> <file>...');
    process.exit(2);
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

const local = [];
const central = [];
let offset = 0;
for (const file of files) {
    const name = Buffer.from(path.basename(file), 'utf8');
    const data = fs.readFileSync(file);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const { time, day } = dosDateTime(fs.statSync(file).mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    lh.writeUInt16LE(8, 8);             // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(day, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);            // external attrs
    ch.writeUInt32LE(offset, 42);       // local header offset

    local.push(lh, name, deflated);
    central.push(ch, name);
    offset += lh.length + name.length + deflated.length;
}

const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${out}: ${files.length} entries, ${fs.statSync(out).size} bytes`);
