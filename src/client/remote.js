// ---------------------------------------------------------------------------
// remote.js - other players' drones (snapshot buffer + interpolation) and the
// 2D overlay (name tags, impact flashes). The 3D quads are drawn by model.js.
// ---------------------------------------------------------------------------

FPV.INTERP_DELAY_MS = 120;
FPV.REMOTE_TIMEOUT_MS = 4000;

FPV.FLAG_ARMED = 1;
FPV.FLAG_CONTROLLED = 2;
FPV.FLAG_CRASHED = 4;

FPV.Remotes = function () {
    this.list = {};    // "pilotId:droneId" -> remote drone
    this.pilots = {};  // pilotId -> name (pilots currently flying)
};

FPV.Remotes.prototype.addPilot = function (pilotId, name) { this.pilots[pilotId] = name; };

FPV.Remotes.prototype.removePilot = function (pilotId) {
    delete this.pilots[pilotId];
    const prefix = pilotId + ':';
    for (const k in this.list) { if (k.indexOf(prefix) === 0) { delete this.list[k]; } }
};

FPV.Remotes.prototype.clear = function () { this.list = {}; this.pilots = {}; };

// entries: [[droneId, x, y, z, qx, qy, qz, qw, flags], ...] for one pilot.
FPV.Remotes.prototype.pushSwarm = function (pilotId, now, entries) {
    const seen = {};
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const key = pilotId + ':' + e[0];
        seen[key] = true;
        let r = this.list[key];
        if (!r) { r = this.list[key] = { key: key, pilot: pilotId, id: e[0], snaps: [], last: 0, pose: null, flags: 0 }; }
        r.snaps.push({ t: now, pos: { x: e[1], y: e[2], z: e[3] }, q: FPV.qNorm({ x: e[4], y: e[5], z: e[6], w: e[7] }) });
        if (r.snaps.length > 20) { r.snaps.shift(); }
        r.last = now;
        r.flags = e[8];
    }
    const prefix = pilotId + ':';
    for (const k in this.list) {
        if (k.indexOf(prefix) === 0 && !seen[k]) { delete this.list[k]; }
    }
};

// Interpolate every remote to (now - delay). Drops remotes that went quiet.
FPV.Remotes.prototype.update = function (now) {
    const t = now - FPV.INTERP_DELAY_MS;
    for (const id in this.list) {
        const r = this.list[id];
        if (now - r.last > FPV.REMOTE_TIMEOUT_MS) { delete this.list[id]; continue; }
        const s = r.snaps;
        if (s.length === 0) { r.pose = null; continue; }
        if (s.length === 1 || t <= s[0].t) { r.pose = { pos: s[0].pos, q: s[0].q }; continue; }
        let i = 1;
        while (i < s.length && s[i].t < t) { i++; }
        if (i >= s.length) {
            // Ran out of data: extrapolate briefly from the last two snapshots.
            const a = s[s.length - 2], b = s[s.length - 1];
            const span = Math.max(b.t - a.t, 1);
            const k = Math.min((t - b.t) / span, 2);
            r.pose = { pos: FPV.lerp3(b.pos, FPV.add(b.pos, FPV.sub(b.pos, a.pos)), k), q: b.q };
        } else {
            const a = s[i - 1], b = s[i];
            const k = FPV.clamp((t - a.t) / Math.max(b.t - a.t, 1), 0, 1);
            r.pose = { pos: FPV.lerp3(a.pos, b.pos, k), q: FPV.qSlerp(a.q, b.q, k) };
        }
        // Velocity estimate for targeting.
        if (s.length >= 2) {
            const a = s[s.length - 2], b = s[s.length - 1];
            r.vel = FPV.scale(FPV.sub(b.pos, a.pos), 1000 / Math.max(b.t - a.t, 1));
        }
    }
};

// ---- drawing (game API) ----------------------------------------------------

FPV.RemoteRenderer = function () {
    this.ready = false;
    this.shadow = new RGBA(0, 0, 0, 200);
    this.nameColor = new RGBA(255, 255, 255, 230);
    this.maxText = new Vector2f(1000, 100);
    try {
        this.texBoom = new Texture('package://fpvdrone/textures/explosion.png');
        this.ready = true;
    } catch (e) {
        if (typeof jcmp.print === 'function') { jcmp.print('[fpvdrone] could not load textures: ' + e); }
    }
};

// 2D pass (Render): labels [{pos, text, color, size}] and impact flashes.
FPV.RemoteRenderer.prototype.draw2d = function (r, labels, effects, camPos, now) {
    for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const d = FPV.dist(l.pos, camPos);
        if (d > 1500 || d < 0.5) { continue; }
        const sp = r.WorldToScreen(new Vector3f(l.pos.x, l.pos.y + 0.6, l.pos.z));
        if (!sp || (sp.x === -1 && sp.y === -1)) { continue; }
        const text = l.text + '  ' + Math.round(d) + 'm';
        const size = l.size || (d < 50 ? 22 : 18);
        const m = r.MeasureText(text, size, 'Arial');
        const x = sp.x - m.x / 2, y = sp.y - m.y;
        r.DrawText(text, new Vector3f(x + 1, y + 1, 0.5), this.maxText, this.shadow, size, 'Arial');
        r.DrawText(text, new Vector3f(x, y, 0.5), this.maxText, l.color || this.nameColor, size, 'Arial');
    }
    if (!this.ready) { return; }
    for (let i = 0; i < effects.length; i++) {
        const e = effects[i];
        const age = (now - e.t0) / 1000;
        if (age < 0 || age > 0.7) { continue; }
        const d = Math.max(FPV.dist(e.pos, camPos), 1);
        const sp = r.WorldToScreen(new Vector3f(e.pos.x, e.pos.y, e.pos.z));
        if (!sp || (sp.x === -1 && sp.y === -1)) { continue; }
        const s = FPV.clamp(2400 / d, 24, 900) * (0.4 + age * 1.6);
        r.DrawTexture(this.texBoom, new Vector2f(sp.x - s / 2, sp.y - s / 2), new Vector2f(s, s));
    }
};
