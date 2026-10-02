// FPV drone UI: input (keyboard + Gamepad API, which also covers RC
// transmitters in USB joystick mode), the OSD, and the settings panel.
// Runs inside JC3MP's CEF. When opened in a normal browser (no `jcmp`) it
// still works for previewing the OSD/menu.
(function () {
    'use strict';

    const J = (typeof jcmp !== 'undefined') ? jcmp : {
        CallEvent: function () {}, AddEvent: function () {}, ShowCursor: function () {}, HideCursor: function () {}
    };

    const DEG = Math.PI / 180;
    const STORAGE_KEY = 'fpvdrone.settings.v2';
    const OLD_STORAGE_KEY = 'fpvdrone.settings.v1';
    // Keys the game script uses for keyboard flying; forwarded as raw up/down.
    const FLIGHT_KEYS = [87, 83, 65, 68, 88, 16, 37, 38, 39, 40];
    const CHANNELS = ['throttle', 'yaw', 'pitch', 'roll', 'arm', 'mode', 'call', 'attack', 'switch'];
    // Momentary channels: a rising edge (button press / switch flip) fires a command.
    const TRIGGERS = ['call', 'attack', 'switch'];
    const KEY_ACTIONS = [
        ['toggle', 'Launch / exit FPV'],
        ['menu', 'Settings menu'],
        ['arm', 'Arm / disarm'],
        ['reset', 'Reset drone to launch point'],
        ['mode', 'Cycle flight mode'],
        ['althold', 'Toggle altitude assist'],
        ['view', 'Cycle view (FPV / chase / line of sight)'],
        ['call', 'Swarm: call in a wingman'],
        ['attack', 'Swarm: attack everything nearby / call off'],
        ['switch', 'Swarm: switch to next drone'],
        ['debug', 'Show input / terrain debug info']
    ];

    const PRESETS = {
        rc: {
            throttle: { src: 'axis:2', invert: false }, yaw: { src: 'axis:3', invert: false },
            pitch: { src: 'axis:1', invert: false }, roll: { src: 'axis:0', invert: false },
            arm: { src: 'axis:4', invert: false }, mode: { src: 'axis:5', invert: false },
            call: { src: 'axis:6', invert: false }, attack: { src: 'axis:7', invert: false },
            switch: { src: 'none', invert: false }
        },
        xbox: {
            throttle: { src: 'axis:1', invert: true }, yaw: { src: 'axis:0', invert: false },
            pitch: { src: 'axis:3', invert: true }, roll: { src: 'axis:2', invert: false },
            arm: { src: 'button:5', invert: false }, mode: { src: 'button:4', invert: false },
            call: { src: 'button:3', invert: false }, attack: { src: 'button:2', invert: false },
            switch: { src: 'button:1', invert: false }
        }
    };

    function defaults() {
        return {
            tune: {
                rates: {
                    roll: { rcRate: 1.0, superRate: 0.70, expo: 0.0 },
                    pitch: { rcRate: 1.0, superRate: 0.70, expo: 0.0 },
                    yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 }
                },
                throttleMid: 0.5,
                throttleExpo: 0.0,
                thrustToWeight: 7.0,
                massKg: 0.65,
                cameraTiltDeg: 25,
                angleMaxDeg: 55,
                crashSpeed: 8.0,
                battery: { enabled: true, cells: 4, capacityMah: 1500 }
            },
            camera: { eulerOrder: 'YXZ', pitchSign: -1, yawSign: -1, rollSign: -1, fovDeg: 92, modelRotSign: 1 },
            mode: 'angle',
            altHold: true,
            view: 'fpv',
            input: {
                device: 'auto',
                gamepadIndex: -1,
                deadband: 0.02,
                kbStrength: 0.6,
                channels: JSON.parse(JSON.stringify(PRESETS.rc)),
                cal: {}
            },
            osd: { ahi: true, noise: true, name: '', sticks: true, debug: false },
            keys: { toggle: 118, menu: 119, arm: 69, reset: 82, mode: 77, althold: 72, view: 86, call: 67, attack: 71, switch: 78, debug: 120 }
        };
    }

    // Deep-merge saved values over defaults (keeps new defaults on upgrade).
    function merge(dst, src) {
        if (!src || typeof src !== 'object') { return dst; }
        Object.keys(src).forEach(function (k) {
            if (dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k]) && k !== 'cal') {
                merge(dst[k], src[k]);
            } else if (src[k] !== undefined) {
                dst[k] = src[k];
            }
        });
        return dst;
    }

    function load() {
        const d = defaults();
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw) {
                merge(d, JSON.parse(raw));
            } else {
                // v1 -> v2: keep the pilot's mapping/rates/keys, but start on the
                // new defaults (angle + altitude assist).
                const old = window.localStorage.getItem(OLD_STORAGE_KEY);
                if (old) {
                    const o = JSON.parse(old);
                    delete o.mode; delete o.altHold;
                    merge(d, o);
                }
            }
        } catch (e) { /* storage unavailable */ }
        return d;
    }

    let S = load();

    function save() {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
    }

    function pushSettings() {
        J.CallEvent('fpv/ui/settings', JSON.stringify({
            tune: S.tune, camera: S.camera, mode: S.mode, altHold: S.altHold, view: S.view,
            kbStrength: S.input.kbStrength
        }));
    }

    function changed() { save(); pushSettings(); }

    // ---- state ------------------------------------------------------------

    let active = false;
    let menuOpen = false;
    let chatOpen = false;
    let osd = null;
    const keys = {};
    let armLatch = false;
    // A controller only takes over once it is actually touched, so a phantom
    // or idle HID device cannot hijack the sticks from the keyboard.
    let padBaseline = null;     // {id, axes}
    let padActive = false;
    let tickCount = 0, tickHz = 0, tickWindow = Date.now();
    let prevButtons = {};
    let lastTick = Date.now();
    let detect = null;          // {channel, axes:[], buttons:[]}
    let cal = null;             // {step, axes:[{min,max}]}
    let bindAction = null;

    // ---- helpers ----------------------------------------------------------

    function $(id) { return document.getElementById(id); }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    function getPath(obj, path) {
        return path.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, obj);
    }
    function setPath(obj, path, val) {
        const parts = path.split('.');
        const last = parts.pop();
        const o = parts.reduce(function (o2, k) { return o2[k]; }, obj);
        o[last] = val;
    }

    function keyName(code) {
        if (code >= 112 && code <= 123) { return 'F' + (code - 111); }
        if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) { return String.fromCharCode(code); }
        const names = { 32: 'Space', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 9: 'Tab', 13: 'Enter', 8: 'Backspace',
            37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 45: 'Insert', 46: 'Delete', 36: 'Home', 35: 'End',
            33: 'PageUp', 34: 'PageDown', 192: '`' };
        return names[code] || ('Key ' + code);
    }

    function toast(text, kind) {
        const el = document.createElement('div');
        el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
        el.textContent = text;
        $('toasts').appendChild(el);
        while ($('toasts').children.length > 4) { $('toasts').removeChild($('toasts').firstChild); }
        setTimeout(function () { el.className += ' fade'; }, 3200);
        setTimeout(function () { if (el.parentNode) { el.parentNode.removeChild(el); } }, 3700);
    }

    function feed(text) {
        const el = document.createElement('div');
        el.textContent = text;
        $('feed').appendChild(el);
        setTimeout(function () { if (el.parentNode) { el.parentNode.removeChild(el); } }, 6000);
    }

    // ---- gamepad ----------------------------------------------------------

    function getPad() {
        if (!navigator.getGamepads) { return null; }
        const pads = navigator.getGamepads();
        if (!pads) { return null; }
        if (S.input.gamepadIndex >= 0 && pads[S.input.gamepadIndex]) { return pads[S.input.gamepadIndex]; }
        for (let i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].axes && pads[i].axes.length >= 2) { return pads[i]; }
        }
        return null;
    }

    function parseSrc(src) {
        const m = /^(axis|button):(\d+)$/.exec(src || '');
        return m ? { type: m[1], index: +m[2] } : { type: 'none', index: -1 };
    }

    function rawAxis(pad, i) { return (pad.axes && i < pad.axes.length) ? (pad.axes[i] || 0) : 0; }
    function rawButton(pad, i) {
        const b = pad.buttons ? pad.buttons[i] : null;
        if (!b) { return false; }
        return typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
    }

    function calFor(i) {
        const c = S.input.cal[i];
        return (c && c.max - c.min > 0.2) ? c : { min: -1, max: 1, center: 0 };
    }

    function normCentered(raw, c) {
        const v = raw >= c.center ? (raw - c.center) / ((c.max - c.center) || 1) : (raw - c.center) / ((c.center - c.min) || 1);
        return clamp(v, -1, 1);
    }

    function normFull(raw, c) { return clamp((raw - c.min) / ((c.max - c.min) || 1), 0, 1); }

    function deadband(v) {
        const db = S.input.deadband;
        const a = Math.abs(v);
        if (a <= db) { return 0; }
        return (v > 0 ? 1 : -1) * (a - db) / (1 - db);
    }

    // Returns the mapped value of a channel, or null if unmapped.
    function channel(pad, name) {
        const ch = S.input.channels[name];
        if (!ch) { return null; }
        const src = parseSrc(ch.src);
        if (src.type === 'axis') {
            const raw = rawAxis(pad, src.index);
            const c = calFor(src.index);
            if (name === 'throttle') {
                const t = normFull(raw, c);
                return ch.invert ? 1 - t : t;
            }
            const v = normCentered(raw, c) * (ch.invert ? -1 : 1);
            return (name === 'arm' || name === 'mode') ? v : deadband(v);
        }
        if (src.type === 'button') {
            const p = rawButton(pad, src.index) !== !!ch.invert;
            return p ? 1 : -1;
        }
        return null;
    }

    function rising(name, value) {
        const was = prevButtons[name];
        const now = value > 0.5;
        prevButtons[name] = now;
        return was === false && now;   // undefined on first read: a switch already ON does not fire
    }

    function readGamepad(pad) {
        const out = {
            t: channel(pad, 'throttle') || 0,
            r: channel(pad, 'roll') || 0,
            p: channel(pad, 'pitch') || 0,
            y: channel(pad, 'yaw') || 0,
            arm: -2,
            mode: -2
        };
        const armSrc = parseSrc(S.input.channels.arm.src);
        const armV = channel(pad, 'arm');
        if (armSrc.type === 'axis') {
            out.arm = armV;
        } else if (armSrc.type === 'button') {
            if (rising('arm', armV)) { armLatch = !armLatch; }
            out.arm = armLatch ? 1 : -1;
        }
        const modeSrc = parseSrc(S.input.channels.mode.src);
        const modeV = channel(pad, 'mode');
        if (modeSrc.type === 'axis') {
            out.mode = modeV;
        } else if (modeSrc.type === 'button' && rising('mode', modeV) && active) {
            J.CallEvent('fpv/ui/cmd', 'mode');
        }
        out.aux = {};
        TRIGGERS.forEach(function (name) {
            const v = channel(pad, name);
            out.aux[name] = v === null ? -2 : v;
            if (v !== null && rising(name, v) && active && !chatOpen) { J.CallEvent('fpv/ui/cmd', name); }
        });
        return out;
    }

    // ---- controller activity -----------------------------------------------

    function padTouched(pad) {
        if (S.input.device === 'gamepad') { return true; }
        if (!padBaseline || padBaseline.id !== pad.id) {
            padBaseline = { id: pad.id, axes: pad.axes.slice() };
            padActive = false;
            return false;
        }
        if (padActive) { return true; }
        for (let i = 0; i < pad.axes.length; i++) {
            if (Math.abs(pad.axes[i] - (padBaseline.axes[i] || 0)) > 0.2) { padActive = true; }
        }
        for (let i = 0; i < pad.buttons.length; i++) {
            if (rawButton(pad, i)) { padActive = true; }
        }
        return padActive;
    }

    // ---- main loop --------------------------------------------------------

    let lastTickAt = 0;
    let lastSent = null;

    function tick() {
        const now = Date.now();
        if (now - lastTickAt < 7) { return; }   // rAF and the interval both drive this
        lastTickAt = now;
        lastTick = now;
        tickCount++;
        if (now - tickWindow >= 1000) { tickHz = tickCount; tickCount = 0; tickWindow = now; }

        const pad = getPad();
        const usePad = pad && S.input.device !== 'keyboard' && padTouched(pad);
        let st = null;
        if (usePad) {
            st = readGamepad(pad);
            if (active || menuOpen) {
                J.CallEvent('fpv/ui/sticks', st.t, st.r, st.p, st.y, st.arm, st.mode, 'gamepad');
                lastSent = st;
            }
        }
        if (menuOpen) { updateMenuLive(pad, st || { t: 0, r: 0, p: 0, y: 0, arm: -2, mode: -2 }); }
        drawOsd(now);
    }

    // ---- OSD --------------------------------------------------------------

    const canvas = $('osd');
    const ctx = canvas.getContext('2d');
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = 192;
    noiseCanvas.height = 108;
    const noiseCtx = noiseCanvas.getContext('2d');
    const noiseImg = noiseCtx.createImageData(192, 108);

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    function txt(s, x, y, align, size, color) {
        const sc = canvas.height / 720;
        ctx.font = 'bold ' + Math.round((size || 18) * sc) + 'px Consolas, "Lucida Console", monospace';
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3 * sc;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(s, x, y);
        ctx.fillStyle = color || '#fff';
        ctx.fillText(s, x, y);
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function fmtTime(t) { const s = Math.floor(t); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); }

    function drawNoise(level) {
        const d = noiseImg.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = Math.random() * 255;
            d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
        }
        noiseCtx.putImageData(noiseImg, 0, 0);
        ctx.save();
        ctx.globalAlpha = clamp(level, 0, 1) * 0.8;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(noiseCanvas, 0, 0, canvas.width, canvas.height);
        // Rolling sync bars.
        ctx.globalAlpha = clamp(level, 0, 1) * 0.5;
        ctx.fillStyle = '#000';
        const n = 1 + Math.floor(level * 4);
        for (let i = 0; i < n; i++) {
            ctx.fillRect(0, Math.random() * canvas.height, canvas.width, 4 + Math.random() * 30 * level);
        }
        ctx.restore();
    }

    function drawHorizon(o, w, h) {
        const fov = S.camera.fovDeg * DEG;
        const focal = (h / 2) / Math.tan(fov / 2);
        const camPitch = o.pitch + o.tilt * DEG;
        const off = clamp(Math.tan(clamp(camPitch, -1.4, 1.4)) * focal, -h, h);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(-o.roll);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash ? ctx.setLineDash([12, 8]) : null;
        ctx.beginPath();
        ctx.moveTo(-w * 0.16, off);
        ctx.lineTo(w * 0.16, off);
        ctx.stroke();
        ctx.restore();
    }

    function drawHomeArrow(x, y, ang, size) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-ang);
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.6, size * 0.7);
        ctx.lineTo(0, size * 0.35);
        ctx.lineTo(-size * 0.6, size * 0.7);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function drawOsd(now) {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!active || !osd) { return; }
        const o = osd;
        const sc = h / 720;
        const blink = Math.floor(now / 400) % 2 === 0;

        if (S.osd.noise && o.noise > 0.01) { drawNoise(o.noise); }

        // crosshair
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash ? ctx.setLineDash([]) : null;
        ctx.beginPath();
        ctx.moveTo(w / 2 - 14 * sc, h / 2); ctx.lineTo(w / 2 - 5 * sc, h / 2);
        ctx.moveTo(w / 2 + 5 * sc, h / 2); ctx.lineTo(w / 2 + 14 * sc, h / 2);
        ctx.moveTo(w / 2, h / 2 - 5 * sc); ctx.lineTo(w / 2, h / 2 - 12 * sc);
        ctx.stroke();

        if (S.osd.ahi && o.view === 'fpv') { drawHorizon(o, w, h); }

        const L = w * 0.12, R = w * 0.88, T = h * 0.1, B = h * 0.9;
        const modeName = { acro: 'ACRO', angle: 'ANGL', horizon: 'HOR' }[o.mode] || o.mode;
        txt(modeName + (o.altHold && o.mode !== 'acro' ? ' AH' : ''), L, T, 'left');
        if (S.osd.name) { txt(S.osd.name.toUpperCase(), w / 2, T, 'center'); }
        txt((o.view === 'fpv' ? '' : o.view.toUpperCase() + '  ') + fmtTime(o.time), R, T, 'right');
        if (o.swarm) {
            const sw = o.swarm;
            const state = sw.atk ? 'ATTACK ' + sw.atk : (sw.mode === 'support' ? 'ORBIT' : 'FORM');
            txt('W' + sw.id + '  SWARM ' + sw.n + '/' + sw.max + (sw.n ? '  ' + state : ''), L, T + 24 * sc, 'left', 15,
                sw.atk ? '#ff6e5a' : '#5adcff');
        }
        if (o.banner) { txt(o.banner, w / 2, h * 0.22, 'center', 24, '#5adcff'); }

        txt(Math.round(o.speed) + ' KM/H', L, h / 2, 'left');
        txt(Math.round(o.alt) + ' M', R, h / 2 - 12 * sc, 'right');
        txt((o.vspeed >= 0 ? '+' : '') + o.vspeed.toFixed(1) + ' M/S', R, h / 2 + 12 * sc, 'right', 14);

        if (o.batt) {
            const low = o.cell < 3.5;
            txt((o.cell * o.cells).toFixed(1) + 'V  ' + o.cell.toFixed(2) + 'V/C', L, B - 22 * sc, 'left', 18,
                low && blink ? '#ff5252' : '#fff');
            txt(Math.round(o.mah) + ' MAH  ' + Math.round(o.amps) + 'A', L, B, 'left', 16);
        }
        txt('THR ' + Math.round(o.thr * 100) + '%', R, B, 'right');

        drawHomeArrow(w / 2, B - 26 * sc, o.homeDir, 11 * sc);
        txt(Math.round(o.home) + 'M', w / 2, B, 'center', 16);

        // centre warnings
        let warn = '';
        let sub = '';
        if (o.handover) {
            warn = '';
        } else if (o.crashed) {
            warn = o.reason === 'WATER' ? 'SPLASH' : (o.reason === 'HIT' ? 'SHOT DOWN' : 'CRASH');
            sub = o.reason === 'WATER' ? 'R TO RESET' : 'E TO RE-ARM   R TO RESET';
        } else if (!o.armed) {
            warn = 'DISARMED';
            sub = o.blocked === 'THROTTLE' ? 'LOWER THROTTLE TO ARM' : 'E / ARM SWITCH TO ARM';
        } else if (o.batt && o.mah >= o.cap) {
            warn = 'BATTERY EMPTY';
        } else if (o.batt && o.cell < 3.5 && blink) {
            warn = 'LOW BATTERY';
        } else if (o.noise > 0.6 && blink) {
            warn = 'SIGNAL LOW';
        }
        if (warn) { txt(warn, w / 2, h * 0.3, 'center', 26, o.crashed ? '#ff5252' : '#fff'); }
        if (sub) { txt(sub, w / 2, h * 0.3 + 28 * sc, 'center', 14, '#cfd8dc'); }

        if (S.osd.sticks && o.sticks) { drawSticks(o, w, h, sc); }
        if (S.osd.debug) { drawDebug(o, sc); }
    }

    // Two small gimbal boxes (mode 2: left = throttle/yaw, right = pitch/roll).
    function drawSticks(o, w, h, sc) {
        const size = 46 * sc, gap = 14 * sc;
        const y0 = h * 0.9 - 70 * sc;
        const boxes = [
            { x: w / 2 - gap / 2 - size, sx: o.sticks.y, sy: o.sticks.t * 2 - 1 },
            { x: w / 2 + gap / 2, sx: o.sticks.r, sy: o.sticks.p }
        ];
        ctx.save();
        ctx.setLineDash ? ctx.setLineDash([]) : null;
        boxes.forEach(function (b) {
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(b.x, y0, size, size);
            const px = b.x + size / 2 + clamp(b.sx, -1, 1) * size / 2;
            const py = y0 + size / 2 - clamp(b.sy, -1, 1) * size / 2;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.beginPath();
            ctx.arc(px, py, 3.5 * sc, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
        txt(o.src === 'gamepad' ? 'RC' : 'KB', w / 2, y0 + size + 10 * sc, 'center', 11, '#cfd8dc');
        ctx.restore();
    }

    function drawDebug(o, sc) {
        const d = o.dbg || {};
        const pad = getPad();
        const lines = [
            'INPUT ' + (o.src === 'gamepad' ? 'controller' : 'keyboard') + '   ui ' + tickHz + 'Hz   game ' + (o.fps || 0) + 'fps',
            'STICKS T ' + o.sticks.t.toFixed(2) + ' Y ' + o.sticks.y.toFixed(2) + ' P ' + o.sticks.p.toFixed(2) + ' R ' + o.sticks.r.toFixed(2),
            'PAD ' + (pad ? (pad.id || '?').slice(0, 40) + (padActive ? ' (active)' : ' (idle - move a stick)') : 'none') +
                '   device ' + S.input.device,
            'TERRAIN probe ' + (d.probeOk || 0) + '/' + (d.probeTries || 0) + '   samples ' + (d.samples || 0) +
                '   floor ' + (d.floor !== undefined ? d.floor + 'm' : '?') + ' (' + (d.floorSrc || '?') + ')',
            'ARMED ' + o.armed + '   mode ' + o.mode + (o.altHold ? '+AH' : '') + '   motor ' + Math.round((o.motor || 0) * 100) + '%'
        ];
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(8 * sc, canvas.height * 0.17, 520 * sc, (lines.length * 17 + 10) * sc);
        lines.forEach(function (l, i) { txt(l, 16 * sc, canvas.height * 0.17 + (14 + i * 17) * sc, 'left', 12, '#b2ff59'); });
        ctx.restore();
    }

    // ---- settings menu ----------------------------------------------------

    function srcOptions() {
        let html = '<option value="none">-</option>';
        for (let i = 0; i < 8; i++) { html += '<option value="axis:' + i + '">Axis ' + i + '</option>'; }
        for (let i = 0; i < 16; i++) { html += '<option value="button:' + i + '">Button ' + i + '</option>'; }
        return html;
    }

    function buildChannels() {
        const body = document.querySelector('#channels tbody');
        body.innerHTML = '';
        CHANNELS.forEach(function (name) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>' + name.charAt(0).toUpperCase() + name.slice(1) + (name === 'mode' ? ' (low acro / mid horizon / high angle)' : '') + (TRIGGERS.indexOf(name) >= 0 ? ' (button / momentary switch)' : '') + '</td>' +
                '<td><select class="ch-src">' + srcOptions() + '</select></td>' +
                '<td><input type="checkbox" class="ch-inv"></td>' +
                '<td><button class="ch-detect">Detect</button></td>' +
                '<td><div class="bar"><i></i></div></td>';
            tr.setAttribute('data-ch', name);
            const sel = tr.querySelector('.ch-src');
            const inv = tr.querySelector('.ch-inv');
            sel.value = S.input.channels[name].src;
            inv.checked = !!S.input.channels[name].invert;
            sel.addEventListener('change', function () { S.input.channels[name].src = sel.value; save(); });
            inv.addEventListener('change', function () { S.input.channels[name].invert = inv.checked; save(); });
            tr.querySelector('.ch-detect').addEventListener('click', function () { startDetect(name, this); });
            body.appendChild(tr);
        });
    }

    function startDetect(name, btn) {
        const pad = getPad();
        if (!pad) { toast('No controller detected - press a button on it first', 'warn'); return; }
        const all = document.querySelectorAll('.ch-detect');
        for (let i = 0; i < all.length; i++) { all[i].className = 'ch-detect'; all[i].textContent = 'Detect'; }
        btn.className = 'ch-detect listening';
        btn.textContent = 'Move it...';
        detect = { channel: name, btn: btn, axes: pad.axes.slice(), buttons: [] };
        for (let i = 0; i < pad.buttons.length; i++) { detect.buttons.push(rawButton(pad, i)); }
    }

    function runDetect(pad) {
        if (!detect || !pad) { return; }
        let found = null;
        for (let i = 0; i < pad.axes.length && i < 8; i++) {
            if (Math.abs(pad.axes[i] - detect.axes[i]) > 0.5) { found = 'axis:' + i; break; }
        }
        if (!found) {
            for (let i = 0; i < pad.buttons.length && i < 16; i++) {
                if (rawButton(pad, i) && !detect.buttons[i]) { found = 'button:' + i; break; }
            }
        }
        if (found) {
            S.input.channels[detect.channel].src = found;
            save();
            detect.btn.className = 'ch-detect';
            detect.btn.textContent = 'Detect';
            const sel = document.querySelector('tr[data-ch="' + detect.channel + '"] .ch-src');
            if (sel) { sel.value = found; }
            toast(detect.channel + ' -> ' + found.replace(':', ' '));
            detect = null;
        }
    }

    function calButton() {
        const pad = getPad();
        if (!pad) { toast('No controller detected - press a button on it first', 'warn'); return; }
        if (!cal) {
            cal = { step: 1, axes: [] };
            for (let i = 0; i < pad.axes.length; i++) { cal.axes.push({ min: pad.axes[i], max: pad.axes[i] }); }
            $('cal-btn').textContent = 'Next';
            $('cal-msg').textContent = 'Move every stick and switch through its full range, then press Next.';
        } else if (cal.step === 1) {
            cal.step = 2;
            $('cal-btn').textContent = 'Finish';
            $('cal-msg').textContent = 'Centre the roll/pitch/yaw sticks, throttle low, then press Finish.';
        } else {
            const out = {};
            for (let i = 0; i < cal.axes.length; i++) {
                const a = cal.axes[i];
                if (a.max - a.min > 0.2) {
                    out[i] = { min: a.min, max: a.max, center: clamp(rawAxis(pad, i), a.min, a.max) };
                }
            }
            S.input.cal = out;
            save();
            cal = null;
            $('cal-btn').textContent = 'Calibrate sticks';
            $('cal-msg').textContent = 'Calibrated ' + Object.keys(out).length + ' axes.';
        }
    }

    function updateMenuLive(pad, st) {
        $('pad-name').textContent = pad ? (pad.id || 'Controller') + ' (' + pad.axes.length + ' axes, ' + pad.buttons.length + ' buttons)'
            : 'No controller detected - press any button on it';
        if (pad) {
            runDetect(pad);
            if (cal && cal.step === 1) {
                for (let i = 0; i < cal.axes.length; i++) {
                    cal.axes[i].min = Math.min(cal.axes[i].min, pad.axes[i]);
                    cal.axes[i].max = Math.max(cal.axes[i].max, pad.axes[i]);
                }
            }
            let raw = '';
            for (let i = 0; i < pad.axes.length && i < 8; i++) { raw += '<span>A' + i + ' ' + pad.axes[i].toFixed(2) + '</span>'; }
            $('raw-axes').innerHTML = raw;
        }
        const aux = st.aux || {};
        const vals = { throttle: st.t * 2 - 1, yaw: st.y, pitch: st.p, roll: st.r, arm: st.arm, mode: st.mode,
            call: aux.call === undefined ? -2 : aux.call, attack: aux.attack === undefined ? -2 : aux.attack,
            switch: aux.switch === undefined ? -2 : aux.switch };
        CHANNELS.forEach(function (name) {
            const bar = document.querySelector('tr[data-ch="' + name + '"] .bar i');
            if (!bar) { return; }
            const v = vals[name] < -1.5 ? 0 : clamp(vals[name], -1, 1);
            const l = v >= 0 ? 50 : 50 + v * 50;
            bar.style.left = l + '%';
            bar.style.width = Math.max(Math.abs(v) * 50, 1) + '%';
        });
        updateMaxRates();
    }

    function bfMax(r) {
        let rc = r.rcRate;
        if (rc > 2) { rc += 14.54 * (rc - 2); }
        return Math.min(200 * rc / Math.max(1 - r.superRate, 0.01), 1998);
    }

    function updateMaxRates() {
        ['roll', 'pitch', 'yaw'].forEach(function (ax) {
            const td = document.querySelector('tr[data-axis="' + ax + '"] .maxrate');
            if (td) { td.textContent = Math.round(bfMax(S.tune.rates[ax])); }
        });
    }

    function buildKeys() {
        const body = document.querySelector('#keys tbody');
        body.innerHTML = '';
        KEY_ACTIONS.forEach(function (a) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>' + a[1] + '</td><td><button class="bind">' + keyName(S.keys[a[0]]) + '</button></td>';
            tr.querySelector('.bind').addEventListener('click', function () {
                bindAction = { action: a[0], btn: this };
                this.className = 'bind listening';
                this.textContent = 'Press a key...';
            });
            body.appendChild(tr);
        });
    }

    function fillForm() {
        $('in-device').value = S.input.device;
        $('in-deadband').value = S.input.deadband;
        $('in-kb').value = S.input.kbStrength;
        $('in-mode').value = S.mode;
        $('in-althold').checked = S.altHold;
        $('cam-fov').value = S.camera.fovDeg;
        $('cam-pitch').checked = S.camera.pitchSign === 1;
        $('cam-yaw').checked = S.camera.yawSign === 1;
        $('cam-roll').checked = S.camera.rollSign === 1;
        $('cam-model').checked = S.camera.modelRotSign === -1;
        $('cam-order').value = S.camera.eulerOrder;
        $('osd-ahi').checked = S.osd.ahi;
        $('osd-noise').checked = S.osd.noise;
        $('osd-sticks').checked = S.osd.sticks;
        $('osd-name').value = S.osd.name;
        const rows = document.querySelectorAll('tr[data-axis]');
        for (let i = 0; i < rows.length; i++) {
            const ax = rows[i].getAttribute('data-axis');
            const ins = rows[i].querySelectorAll('input');
            for (let j = 0; j < ins.length; j++) { ins[j].value = S.tune.rates[ax][ins[j].getAttribute('data-k')]; }
        }
        const tunes = document.querySelectorAll('[data-tune]');
        for (let i = 0; i < tunes.length; i++) {
            const v = getPath(S.tune, tunes[i].getAttribute('data-tune'));
            if (tunes[i].type === 'checkbox') { tunes[i].checked = !!v; } else { tunes[i].value = v; }
        }
        buildChannels();
        buildKeys();
        updateMaxRates();
    }

    function num(el, fallback) {
        const v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
    }

    function wireForm() {
        $('in-device').addEventListener('change', function () { S.input.device = this.value; save(); });
        $('in-deadband').addEventListener('change', function () { S.input.deadband = clamp(num(this, 0.02), 0, 0.2); save(); });
        $('in-kb').addEventListener('change', function () { S.input.kbStrength = clamp(num(this, 0.6), 0.1, 1); changed(); });
        $('in-mode').addEventListener('change', function () { S.mode = this.value; changed(); });
        $('in-althold').addEventListener('change', function () { S.altHold = this.checked; changed(); });
        $('cam-fov').addEventListener('change', function () { S.camera.fovDeg = clamp(num(this, 92), 40, 150); changed(); });
        $('cam-pitch').addEventListener('change', function () { S.camera.pitchSign = this.checked ? 1 : -1; changed(); });
        $('cam-yaw').addEventListener('change', function () { S.camera.yawSign = this.checked ? 1 : -1; changed(); });
        $('cam-roll').addEventListener('change', function () { S.camera.rollSign = this.checked ? 1 : -1; changed(); });
        $('cam-model').addEventListener('change', function () { S.camera.modelRotSign = this.checked ? -1 : 1; changed(); });
        $('cam-order').addEventListener('change', function () { S.camera.eulerOrder = this.value; changed(); });
        $('cam-reset').addEventListener('click', function () {
            const d = defaults().camera;
            S.camera.eulerOrder = d.eulerOrder; S.camera.pitchSign = d.pitchSign; S.camera.yawSign = d.yawSign;
            S.camera.rollSign = d.rollSign; S.camera.modelRotSign = d.modelRotSign;
            fillForm(); changed();
        });
        $('osd-ahi').addEventListener('change', function () { S.osd.ahi = this.checked; save(); });
        $('osd-noise').addEventListener('change', function () { S.osd.noise = this.checked; save(); });
        $('osd-sticks').addEventListener('change', function () { S.osd.sticks = this.checked; save(); });
        $('osd-name').addEventListener('change', function () { S.osd.name = this.value; save(); });

        const rows = document.querySelectorAll('tr[data-axis]');
        for (let i = 0; i < rows.length; i++) {
            const ax = rows[i].getAttribute('data-axis');
            const ins = rows[i].querySelectorAll('input');
            for (let j = 0; j < ins.length; j++) {
                ins[j].addEventListener('change', function () {
                    const k = this.getAttribute('data-k');
                    S.tune.rates[ax][k] = clamp(num(this, S.tune.rates[ax][k]), 0, k === 'rcRate' ? 2.55 : 1);
                    this.value = S.tune.rates[ax][k];
                    changed();
                });
            }
        }
        const tunes = document.querySelectorAll('[data-tune]');
        for (let i = 0; i < tunes.length; i++) {
            tunes[i].addEventListener('change', function () {
                const path = this.getAttribute('data-tune');
                if (this.type === 'checkbox') {
                    setPath(S.tune, path, this.checked);
                } else {
                    const min = parseFloat(this.min), max = parseFloat(this.max);
                    let v = num(this, getPath(S.tune, path));
                    if (isFinite(min)) { v = Math.max(v, min); }
                    if (isFinite(max)) { v = Math.min(v, max); }
                    setPath(S.tune, path, v);
                    this.value = v;
                }
                changed();
            });
        }

        $('preset-rc').addEventListener('click', function () {
            S.input.channels = JSON.parse(JSON.stringify(PRESETS.rc)); S.input.cal = {}; save(); buildChannels();
        });
        $('preset-xbox').addEventListener('click', function () {
            S.input.channels = JSON.parse(JSON.stringify(PRESETS.xbox)); S.input.cal = {}; save(); buildChannels();
        });
        $('cal-btn').addEventListener('click', calButton);
        $('reset-all').addEventListener('click', function () {
            S = defaults(); save(); fillForm(); pushSettings(); toast('Settings restored to defaults');
        });

        const tabs = document.querySelectorAll('.tabs button');
        for (let i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () {
                for (let j = 0; j < tabs.length; j++) { tabs[j].className = ''; }
                this.className = 'active';
                const all = document.querySelectorAll('.tab');
                for (let j = 0; j < all.length; j++) { all[j].className = 'tab hidden'; }
                $('tab-' + this.getAttribute('data-tab')).className = 'tab';
            });
        }
        $('menu-close').addEventListener('click', function () { setMenu(false); });
    }

    function setMenu(open) {
        menuOpen = open;
        $('menu').className = open ? '' : 'hidden';
        if (open) { fillForm(); J.ShowCursor(); } else { J.HideCursor(); detect = null; cal = null; bindAction = null; }
        J.CallEvent('fpv/ui/menu', open);
    }

    // ---- keyboard events --------------------------------------------------

    function typing() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' && el.type !== 'checkbox') || (el && el.tagName === 'SELECT');
    }

    document.addEventListener('keydown', function (e) {
        const code = e.keyCode;
        if (bindAction) {
            if (code !== 27) { S.keys[bindAction.action] = code; save(); }
            bindAction = null;
            buildKeys();
            e.preventDefault();
            return;
        }
        if (chatOpen) { return; }
        if (menuOpen && typing() && code !== 27) { return; }
        const repeat = keys[code];
        keys[code] = true;
        if (repeat) { return; }
        if (FLIGHT_KEYS.indexOf(code) >= 0) { J.CallEvent('fpv/ui/key', code, 1); }
        if (code === S.keys.debug) { S.osd.debug = !S.osd.debug; save(); return; }

        if (code === S.keys.menu || (code === 27 && menuOpen)) { setMenu(!menuOpen); return; }
        if (code === S.keys.toggle) { J.CallEvent('fpv/ui/cmd', 'toggle'); return; }
        if (!active) { return; }
        if (code === S.keys.arm) { J.CallEvent('fpv/ui/cmd', 'arm'); }
        else if (code === S.keys.reset) { J.CallEvent('fpv/ui/cmd', 'reset'); }
        else if (code === S.keys.mode) { J.CallEvent('fpv/ui/cmd', 'mode'); }
        else if (code === S.keys.althold) { J.CallEvent('fpv/ui/cmd', 'althold'); }
        else if (code === S.keys.view) { J.CallEvent('fpv/ui/cmd', 'view'); }
        else if (code === S.keys.call) { J.CallEvent('fpv/ui/cmd', 'call'); }
        else if (code === S.keys.attack) { J.CallEvent('fpv/ui/cmd', 'attack'); }
        else if (code === S.keys.switch) { J.CallEvent('fpv/ui/cmd', 'switch'); }
    });

    document.addEventListener('keyup', function (e) {
        keys[e.keyCode] = false;
        if (FLIGHT_KEYS.indexOf(e.keyCode) >= 0) { J.CallEvent('fpv/ui/key', e.keyCode, 0); }
    });
    function releaseAll() {
        for (const k in keys) {
            if (keys[k] && FLIGHT_KEYS.indexOf(+k) >= 0) { J.CallEvent('fpv/ui/key', +k, 0); }
            keys[k] = false;
        }
    }
    window.addEventListener('blur', releaseAll);

    // ---- events from the client script -------------------------------------

    J.AddEvent('fpv/active', function (on) {
        active = !!on;
        osd = null;
        armLatch = false;
        padActive = S.input.device === 'gamepad';
        padBaseline = null;
    });

    J.AddEvent('fpv/osd', function (json) {
        try { osd = JSON.parse(json); } catch (e) { /* ignore */ }
    });

    J.AddEvent('fpv/notify', function (text, kind) { toast(text, kind); });
    J.AddEvent('fpv/feed', function (text) { feed(text); });
    J.AddEvent('fpv/chat', function (open) {
        chatOpen = !!open;
        if (chatOpen) { releaseAll(); }
    });

    J.AddEvent('fpv/mode_changed', function (mode, altHold) {
        const changedMode = mode !== S.mode;
        S.mode = mode;
        S.altHold = !!altHold;
        save();
        toast(changedMode ? 'Mode: ' + mode.toUpperCase() : 'Altitude assist ' + (S.altHold ? 'ON' : 'OFF'));
    });

    J.AddEvent('fpv/view_changed', function (view) {
        S.view = view;
        save();
        toast('View: ' + { fpv: 'FPV', chase: 'Chase', los: 'Line of sight' }[view]);
    });

    J.AddEvent('fpv/config', function () { /* reserved: server config is applied client-side */ });

    // ---- boot -------------------------------------------------------------

    wireForm();
    fillForm();
    setInterval(tick, 10);
    (function raf() { tick(); window.requestAnimationFrame(raf); })();
    pushSettings();
    J.CallEvent('fpv/ui/ready');

    // Preview helper when opened in a normal browser: ?preview shows a fake OSD.
    if (typeof jcmp === 'undefined' && /preview/.test(location.search)) {
        active = true;
        osd = { armed: true, crashed: false, mode: 'angle', altHold: true, view: 'fpv', thr: 0.42, speed: 87, vspeed: 1.3,
            alt: 34, home: 412, homeDir: 0.6, pitch: -0.3, roll: 0.25, tilt: 25, cell: 3.82, cells: 4, mah: 512,
            cap: 1500, batt: true, amps: 31, time: 83, noise: 0.15, probe: true,
            swarm: { n: 3, max: 5, mode: 'support', atk: 0, id: 2 }, banner: 'LINK > W2  AUTO-AIM',
            sticks: { t: 0.55, y: -0.2, p: 0.4, r: 0.15 }, src: 'keyboard', fps: 60,
            dbg: { probeOk: 812, probeTries: 1400, samples: 655, floor: -3.2, floorSrc: 'map', pad: false } };
        S.osd.debug = /debug/.test(location.search);
        if (/menu/.test(location.search)) { setMenu(true); }
    }
})();
