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

function hash(x, y) {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
}

function shade(c, k) { return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k), c[3] === undefined ? 255 : c[3]]; }

// 2x2 twill carbon weave with a soft sheen; k = brightness for the face.
function carbon(k) {
    return function (u, v) {
        const n = 16;
        const cx = Math.floor(u * n), cy = Math.floor(v * n);
        const fx = u * n - cx, fy = v * n - cy;
        const weave = ((cx + cy) >> 1) % 2 === 0;
        const along = weave ? fx : fy;
        const sheen = 0.75 + 0.35 * Math.sin(along * Math.PI);
        const grain = 0.92 + 0.08 * hash(cx, cy);
        const edge = Math.min(u, v, 1 - u, 1 - v) < 0.04 ? 1.5 : 1;   // chamfered edge highlight
        const b = 30 * sheen * grain * k * edge;
        return [b, b * 1.04, b * 1.1, 255];
    };
}

const RED = [176, 28, 22];
const YELLOW = [236, 182, 20];

function accent(u, v) {
    const g = 0.85 + 0.15 * hash(Math.floor(u * 8), Math.floor(v * 8));
    return shade([RED[0], RED[1], RED[2], 255], g);
}

// Motor bell side: anodised red with dark cooling slots and a steel base ring.
function motorSide(u, v) {
    if (v > 0.78) { return [120, 122, 128, 255]; }
    if (v > 0.18 && v < 0.6 && (u * 6) % 1 < 0.35) { return [25, 20, 20, 255]; }
    const k = 0.7 + 0.5 * Math.sin(u * Math.PI);
    return shade([RED[0], RED[1], RED[2], 255], k);
}

// Motor top: round bell with shaft and prop nut, transparent corners.
function motorTop(u, v) {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    if (r > 1) { return null; }
    if (r < 0.22) { return [200, 200, 205, 255]; }
    if (r < 0.32) { return [40, 40, 44, 255]; }
    if (r > 0.88) { return shade([RED[0], RED[1], RED[2], 255], 0.7); }
    const spokes = Math.abs(Math.sin(Math.atan2(v - 0.5, u - 0.5) * 3)) < 0.35;
    return spokes ? [30, 24, 24, 255] : shade([RED[0], RED[1], RED[2], 255], 1.05);
}

// LiPo: black shrink wrap, yellow brand band; end shows the balance lead.
function batteryTop(u, v) {
    if (v > 0.42 && v < 0.58) { return shade([YELLOW[0], YELLOW[1], YELLOW[2], 255], 0.95); }
    const b = 22 + 8 * Math.sin(u * Math.PI);
    return [b, b, b + 2, 255];
}
function batterySide(u, v) {
    if (u > 0.42 && u < 0.58) { return shade([YELLOW[0], YELLOW[1], YELLOW[2], 255], 0.75); }
    const b = 16 + 6 * Math.sin(v * Math.PI);
    return [b, b, b + 2, 255];
}
function batteryEnd(u, v) {
    if (Math.abs(u - 0.3) < 0.08 && v > 0.2 && v < 0.8) { return [200, 30, 30, 255]; }
    if (Math.abs(u - 0.7) < 0.08 && v > 0.2 && v < 0.8) { return [20, 20, 20, 255]; }
    return [28, 28, 30, 255];
}

// FPV camera: lens with a blue-green coating reflection.
function camFront(u, v) {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    if (r < 0.62) {
        const hl = Math.hypot(u - 0.4, v - 0.38) < 0.12;
        if (hl) { return [180, 220, 230, 255]; }
        return [20 + 30 * (1 - r), 40 + 70 * (1 - r), 60 + 60 * (1 - r), 255];
    }
    if (r < 0.75) { return [60, 60, 66, 255]; }
    return [34, 34, 38, 255];
}
function camSide(u, v) { const b = 36 + 10 * hash(Math.floor(u * 4), Math.floor(v * 4)); return [b, b, b + 3, 255]; }

function antenna(u, v) {
    if (v < 0.12) { return [190, 30, 30, 255]; }
    const k = 0.7 + 0.5 * Math.sin(u * Math.PI);
    return [20 * k, 20 * k, 22 * k, 255];
}

// Spinning prop: translucent disc with faint blade streaks.
function propBlur(u, v) {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    if (r > 1 || r < 0.08) { return null; }
    const ang = Math.atan2(dy, dx);
    const streak = 0.5 + 0.5 * Math.cos(ang * 3);
    const a = (40 + 50 * streak) * (r > 0.92 ? 1.6 : 1);
    return [RED[0] * 0.6 + 40, RED[1] + 30, RED[2] + 30, Math.min(255, a)];
}

// Stopped prop: three tri-blades.
function propStill(u, v) {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    if (r > 1) { return null; }
    if (r < 0.12) { return [30, 30, 30, 255]; }
    const ang = Math.atan2(dy, dx);
    for (let i = 0; i < 3; i++) {
        let d = ang - (i * 2 * Math.PI / 3 + 0.25 * r);
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const width = 0.22 * (1 - r * 0.55);
        if (Math.abs(d) < width) { return shade([RED[0], RED[1], RED[2], 230], 0.8 + 0.4 * (1 - r)); }
    }
    return null;
}

// Radio: gunmetal body, two gimbals and a small screen.
function radioFace(u, v) {
    for (const gx of [0.27, 0.73]) {
        const r = Math.hypot(u - gx, (v - 0.55) * 0.65);
        if (r < 0.04) { return [210, 210, 215, 255]; }
        if (r < 0.15) { return [18, 18, 20, 255]; }
        if (r < 0.17) { return [90, 90, 96, 255]; }
    }
    if (u > 0.4 && u < 0.6 && v > 0.15 && v < 0.35) { return [40, 120, 170, 255]; }
    const b = 52 + 10 * Math.sin(v * Math.PI);
    return [b, b + 2, b + 6, 255];
}
function radioSide(u, v) { const b = 44 + 8 * hash(Math.floor(u * 6), Math.floor(v * 6)); return [b, b + 1, b + 4, 255]; }
function radioTop(u, v) {
    for (const sx of [0.15, 0.3, 0.7, 0.85]) {
        if (Math.abs(u - sx) < 0.025 && v > 0.3 && v < 0.7) { return [200, 200, 205, 255]; }
    }
    return radioSide(u, v);
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
    for (const f of fs.readdirSync(OUT)) { if (f.endsWith('.png')) { fs.unlinkSync(path.join(OUT, f)); } }
    const textures = {
        carbon_top: carbon(1.25), carbon_side: carbon(0.8), carbon_bottom: carbon(0.55),
        accent: accent, motor_top: motorTop, motor_side: motorSide,
        battery_top: batteryTop, battery_side: batterySide, battery_end: batteryEnd,
        cam_front: camFront, cam_side: camSide, antenna: antenna,
        prop_blur: propBlur, prop_still: propStill,
        radio_face: radioFace, radio_side: radioSide, radio_top: radioTop,
        explosion: explosion
    };
    for (const name in textures) {
        const size = name === 'explosion' || name.indexOf('prop') === 0 ? 128 : 64;
        fs.writeFileSync(path.join(OUT, name + '.png'), png(size, size, raster(size, size, textures[name])));
    }
    console.log('wrote ' + Object.keys(textures).length + ' textures to ' + path.relative(process.cwd(), OUT));
}

main();
