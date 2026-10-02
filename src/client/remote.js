// ---------------------------------------------------------------------------
// remote.js - other players' drones: snapshot buffer, interpolation, drawing.
// ---------------------------------------------------------------------------

FPV.INTERP_DELAY_MS = 120;
FPV.REMOTE_TIMEOUT_MS = 4000;

FPV.Remotes = function () {
    this.list = {};   // networkId -> remote
};

FPV.Remotes.prototype.ensure = function (id, name) {
    let r = this.list[id];
    if (!r) {
        r = this.list[id] = { id: id, name: name || ('Pilot ' + id), snaps: [], last: 0, pose: null, armed: false, throttle: 0 };
    }
    if (name) { r.name = name; }
    return r;
};

FPV.Remotes.prototype.remove = function (id) { delete this.list[id]; };
FPV.Remotes.prototype.clear = function () { this.list = {}; };

FPV.Remotes.prototype.push = function (id, now, pos, q, armed, throttle) {
    const r = this.ensure(id);
    r.snaps.push({ t: now, pos: pos, q: FPV.qNorm(q) });
    if (r.snaps.length > 20) { r.snaps.shift(); }
    r.last = now;
    r.armed = armed;
    r.throttle = throttle;
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
    }
};

// ---- drawing (game API) ----------------------------------------------------

FPV.RemoteRenderer = function () {
    this.ready = false;
    this.size = 0.5;          // drawn a bit larger than a real 5" quad so it is visible
    this.color = new RGBA(255, 255, 255, 255);
    this.nameColor = new RGBA(255, 255, 255, 230);
    this.shadow = new RGBA(0, 0, 0, 200);
    this.armedColor = new RGBA(80, 255, 120, 230);
    this.maxText = new Vector2f(1000, 100);
    this.xAxis = new Vector3f(1, 0, 0);
    try {
        this.texTop = new Texture('package://fpvdrone/textures/drone_top.png');
        this.texSide = new Texture('package://fpvdrone/textures/drone_side.png');
        this.ready = true;
    } catch (e) {
        jcmp.print && jcmp.print('[fpvdrone] could not load textures: ' + e);
    }
};

// 3D pass (GameUpdateRender): textured quads at the interpolated pose.
FPV.RemoteRenderer.prototype.draw3d = function (r, remotes, camPos, modelRotSign) {
    if (!this.ready) { return; }
    const half = this.size / 2;
    const topPos = new Vector3f(-half, -half, 0);
    const topSize = new Vector2f(this.size, this.size);
    const sideH = this.size * 0.25;
    const sidePos = new Vector3f(-half, -sideH / 2, 0);
    const sideSize = new Vector2f(this.size, sideH);
    for (const id in remotes.list) {
        const rm = remotes.list[id];
        if (!rm.pose) { continue; }
        if (FPV.dist(rm.pose.pos, camPos) > 1500) { continue; }
        const aa = FPV.qToAxisAngle(rm.pose.q);
        const pos = new Vector3f(rm.pose.pos.x, rm.pose.pos.y, rm.pose.pos.z);
        const axis = new Vector3f(aa.axis.x, aa.axis.y, aa.axis.z);
        const angle = aa.angle * modelRotSign;
        // Matrices are rebuilt rather than reused in case Matrix ops mutate.
        // Top-down silhouette lying in the body XZ plane...
        r.SetTransform(new Matrix().Translate(pos).Rotate(angle, axis).Rotate(Math.PI / 2, this.xAxis));
        r.DrawTexture(this.texTop, topPos, topSize);
        // ...plus a vertical strip across the body so it is visible edge-on.
        r.SetTransform(new Matrix().Translate(pos).Rotate(angle, axis));
        r.DrawTexture(this.texSide, sidePos, sideSize);
    }
};

// 2D pass (Render): name tag + distance above each drone.
FPV.RemoteRenderer.prototype.draw2d = function (r, remotes, camPos) {
    for (const id in remotes.list) {
        const rm = remotes.list[id];
        if (!rm.pose) { continue; }
        const d = FPV.dist(rm.pose.pos, camPos);
        if (d > 1500) { continue; }
        const p = rm.pose.pos;
        const sp = r.WorldToScreen(new Vector3f(p.x, p.y + 0.6, p.z));
        if (!sp || (sp.x === -1 && sp.y === -1)) { continue; }
        const text = rm.name + '  ' + Math.round(d) + 'm';
        const size = d < 50 ? 22 : 18;
        const m = r.MeasureText(text, size, 'Arial');
        const x = sp.x - m.x / 2, y = sp.y - m.y;
        r.DrawText(text, new Vector3f(x + 1, y + 1, 0.5), this.maxText, this.shadow, size, 'Arial');
        r.DrawText(text, new Vector3f(x, y, 0.5), this.maxText, rm.armed ? this.armedColor : this.nameColor, size, 'Arial');
    }
};
