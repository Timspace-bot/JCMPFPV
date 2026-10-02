#!/usr/bin/env node
// Generates the drone textures used to draw other players' quads.
// Tiny dependency-free PNG writer + rasteriser so the repo has no binary
// tooling requirements: `npm run textures`.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'packages', 'fpvdrone', 'client_package', 'textures');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Supersampled rasteriser over a signed "shape" function returning a colour
// or null for each sample point in [0,1]^2.
function raster(w, h, shape, ss) {
    ss = ss || 4;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const c = shape((x + (sx + 0.5) / ss) / w, (y + (sy + 0.5) / ss) / h);
                    if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
                }
            }
            const n = ss * ss;
            const i = (y * w + x) * 4;
            buf[i + 3] = Math.round(a / n);
            if (a > 0) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); }
        }
    }
    return buf;
}

function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return Math.sqrt(x * x + y * y);
}

const CARBON = [30, 32, 36, 255];
const FRONT = [255, 120, 30, 255];      // orange props mark the nose
const REAR = [230, 230, 235, 255];
const BODY = [60, 64, 72, 255];
const LED = [80, 255, 140, 255];

// Top view, nose towards v = 0 (top of the image).
function droneTop(u, v) {
    const motors = [[0.2, 0.2, true], [0.8, 0.2, true], [0.2, 0.8, false], [0.8, 0.8, false]];
    for (const m of motors) {
        const d = Math.hypot(u - m[0], v - m[1]);
        if (d < 0.05) { return BODY; }
        if (d < 0.17 && d > 0.155) { return m[2] ? FRONT : REAR; }      // prop guard ring
        if (d < 0.155) {
            // translucent prop disc with two blades
            const ang = Math.atan2(v - m[1], u - m[0]);
            const blade = Math.abs(Math.sin(ang)) < 0.18;
            const c = m[2] ? FRONT : REAR;
            return blade ? c : [c[0], c[1], c[2], 70];
        }
    }
    if (segDist(u, v, 0.2, 0.2, 0.8, 0.8) < 0.035 || segDist(u, v, 0.8, 0.2, 0.2, 0.8) < 0.035) { return CARBON; }
    if (Math.abs(u - 0.5) < 0.09 && Math.abs(v - 0.5) < 0.16) {
        if (v < 0.37 && Math.abs(u - 0.5) < 0.05) { return [20, 20, 20, 255]; }   // FPV camera
        return BODY;
    }
    if (Math.abs(u - 0.5) < 0.02 && v > 0.66 && v < 0.75) { return LED; }
    return null;
}

// Side strip: body stack + motor bells, drawn vertically across the quad.
function droneSide(u, v) {
    if (v > 0.35 && v < 0.75 && u > 0.38 && u < 0.62) { return BODY; }
    if (v > 0.6 && v < 0.72 && u > 0.12 && u < 0.88) { return CARBON; }
    for (const mx of [0.2, 0.8]) {
        if (Math.abs(u - mx) < 0.05 && v > 0.3 && v < 0.62) { return [90, 90, 98, 255]; }
        if (Math.abs(u - mx) < 0.16 && v > 0.26 && v < 0.31) { return [200, 200, 205, 160]; }
    }
    return null;
}

// Impact flash: hot core fading through orange to transparent, with spikes.
function explosion(u, v) {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * 2;
    const ang = Math.atan2(dy, dx);
    const spikes = 0.82 + 0.18 * Math.pow(Math.abs(Math.sin(ang * 5 + 0.7) * Math.cos(ang * 3)), 0.5);
    const e = r / spikes;
    if (e >= 1) { return null; }
    const core = Math.max(0, 1 - e / 0.35);
    const col = [255, Math.round(120 + 135 * core), Math.round(30 + 200 * core * core)];
    return [col[0], col[1], col[2], Math.round(255 * Math.pow(1 - e, 0.7))];
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'drone_top.png'), png(128, 128, raster(128, 128, droneTop)));
    fs.writeFileSync(path.join(OUT, 'drone_side.png'), png(128, 32, raster(128, 32, droneSide)));
    fs.writeFileSync(path.join(OUT, 'explosion.png'), png(128, 128, raster(128, 128, explosion)));
    console.log('wrote textures to ' + path.relative(process.cwd(), OUT));
}

main();
