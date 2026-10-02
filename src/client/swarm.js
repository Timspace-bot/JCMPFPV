// ---------------------------------------------------------------------------
// swarm.js - AI wingmen that fly the same physics model as the player.
//
// Behaviours (per wingman `role`):
//   join   - fly to a slot in a dynamic formation around the controlled drone:
//            a wedge behind it when it is moving, a slow ring when it hovers.
//   orbit  - "support": circle the point the player is diving at, at least
//            `orbitMinHeight` above it, cameras facing the centre, so one of
//            them can take over straight after the player's drone impacts.
//   attack - pursue and ram an assigned target (proportional lead).
//   aim    - handover: pitch so the FPV camera points at a spot, then the
//            client gives this drone to the player.
//   wreck  - crashed; falls and is removed after a while.
//
// All pure JS: the client supplies the leader state, a floor lookup and a
// target list; the swarm returns events (impacts, losses).
// ---------------------------------------------------------------------------

FPV.SWARM_DEFAULTS = {
    maxWingmen: 5,
    formationMinHeight: 4,   // m above known ground while in formation
    orbitMinHeight: 25,      // m above the attack point while circling
    orbitRadius: 35,
    orbitSpeed: 11,          // m/s tangential
    cruiseSpeed: 60,         // m/s max transit speed
    attackSpeed: 50,
    attackRadius: 150,       // targets are picked within this range of the leader
    hitRadius: 2.2,
    wreckSeconds: 15,
    impactMinSpeed: 10       // m/s - slower crashes do no damage
};

FPV.SWARM_STEP = 1 / 120;

// Turn a guidance command into direct rate/thrust input for FPV.step.
//   cmd.vel        desired world velocity
//   cmd.face       world direction the nose (or camera, with aimCamera) should face
//   cmd.aimCamera  point the tilted FPV camera along cmd.face instead of the nose
//   cmd.aimThrust  thrust fraction to hold while aiming
FPV.autopilot = function (s, cmd, tune) {
    const g = tune.gravity;
    const maxAcc = tune.thrustToWeight * g;
    let qDes;
    let thrust;

    if (cmd.aimCamera) {
        const tilt = FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, -tune.cameraTiltDeg * FPV.DEG);
        qDes = FPV.qMul(FPV.lookRotation(cmd.face), tilt);
        thrust = cmd.aimThrust !== undefined ? cmd.aimThrust : 1 / tune.thrustToWeight;
    } else {
        let a = FPV.scale(FPV.sub(cmd.vel, s.vel), cmd.velGain || 2.5);
        // Feed-forward the drag we will meet at the commanded speed.
        a = FPV.sub(a, FPV.scale(FPV.dragForce(s.q, cmd.vel, tune), 1 / tune.massKg));
        const aMax = cmd.maxAccel || 24;
        const ah = Math.sqrt(a.x * a.x + a.z * a.z);
        if (ah > aMax) { a.x *= aMax / ah; a.z *= aMax / ah; }
        const f = { x: a.x, y: FPV.clamp(a.y, -0.75 * g, maxAcc) + g, z: a.z };
        const maxTilt = (cmd.maxTiltDeg || 60) * FPV.DEG;
        const fh = Math.sqrt(f.x * f.x + f.z * f.z);
        if (fh > 1e-6 && Math.atan2(fh, f.y) > maxTilt) {
            const k = f.y * Math.tan(maxTilt) / fh;
            f.x *= k; f.z *= k;
        }
        const fl = FPV.len(f);
        const up = FPV.scale(f, 1 / fl);
        thrust = fl / maxAcc;

        let fwd = cmd.face && FPV.len(FPV.horiz(cmd.face)) > 1e-3 ? cmd.face : FPV.qRotate(s.q, { x: 0, y: 0, z: -1 });
        let proj = FPV.sub(fwd, FPV.scale(up, FPV.dot(fwd, up)));
        if (FPV.len(proj) < 1e-3) { proj = FPV.qRotate(s.q, { x: 0, y: 0, z: -1 }); }
        const Z = FPV.scale(FPV.norm(proj), -1);
        const X = FPV.norm(FPV.cross(up, Z));
        qDes = FPV.quatFromBasis(X, up, FPV.cross(X, up));
    }

    let err = FPV.qMul(FPV.qConj(s.q), qDes);
    if (err.w < 0) { err = { x: -err.x, y: -err.y, z: -err.z, w: -err.w }; }
    const aa = FPV.qToAxisAngle(err);
    const gain = 9;
    const w = FPV.clampLen(FPV.scale(aa.axis, aa.angle * gain), 14);
    return { mode: 'direct', wDes: w, thrustCmd: FPV.clamp(thrust, 0, 1), throttle: 0, roll: 0, pitch: 0, yaw: 0 };
};

FPV.Swarm = function (opts, tune) {
    this.opts = {};
    for (const k in FPV.SWARM_DEFAULTS) { this.opts[k] = FPV.SWARM_DEFAULTS[k]; }
    this.configure(opts);
    this.setTune(tune || FPV.DEFAULT_TUNE);
    this.wingmen = [];
    this.nextId = 1;
    this.mode = 'formation';     // formation | support
    this.center = null;          // support orbit centre
    this.supportSince = 0;
    this.diveTime = 0;
    this.time = 0;
    this.acc = 0;
    this.events = [];
};

FPV.Swarm.prototype.configure = function (opts) {
    if (!opts) { return; }
    for (const k in this.opts) {
        if (typeof opts[k] === 'number' && isFinite(opts[k])) { this.opts[k] = opts[k]; }
    }
};

FPV.Swarm.prototype.setTune = function (tune) {
    this.tune = FPV.cloneTune(tune);
    this.tune.battery.enabled = false;   // wingmen don't run out mid-fight
};

FPV.Swarm.prototype.flying = function () {
    return this.wingmen.filter(function (w) { return w.role !== 'wreck'; });
};

FPV.Swarm.prototype.attackers = function () {
    return this.wingmen.filter(function (w) { return w.role === 'attack'; });
};

FPV.Swarm.prototype.add = function (state, role, id) {
    const w = {
        id: id !== undefined ? id : this.nextId++,
        s: state,
        role: role || 'join',
        target: null,
        aimPoint: null,
        phase: Math.random() * Math.PI * 2,
        age: 0,
        input: null
    };
    if (w.id >= this.nextId) { this.nextId = w.id + 1; }
    this.wingmen.push(w);
    return w;
};

// Launch a new wingman from `pos` (it takes off and flies to the formation).
FPV.Swarm.prototype.spawn = function (pos, q) {
    if (this.flying().length >= this.opts.maxWingmen) { return null; }
    const s = FPV.createState(pos, q);
    s.armed = true;
    s.onGround = true;
    return this.add(s, 'join');
};

FPV.Swarm.prototype.remove = function (w) {
    const i = this.wingmen.indexOf(w);
    if (i >= 0) { this.wingmen.splice(i, 1); }
};

FPV.Swarm.prototype.wreck = function (s, id) {
    const w = this.add(s, 'wreck', id);
    w.age = 0;
    return w;
};

// Circle `point` (e.g. where the player just crashed).
FPV.Swarm.prototype.focus = function (point) {
    this.mode = 'support';
    this.center = { x: point.x, y: point.y, z: point.z };
    this.supportSince = this.time;
    this.wingmen.forEach(function (w) { if (w.role === 'join') { w.role = 'orbit'; } });
};

FPV.Swarm.prototype.predictImpact = function (L, env) {
    const ground = env.floorAt({ x: L.pos.x, y: L.pos.y, z: L.pos.z }).y;
    const t = FPV.clamp((L.pos.y - ground) / Math.max(-L.vel.y, 1), 0, 6);
    const p = FPV.add(L.pos, FPV.scale(L.vel, t));
    p.y = Math.max(env.floorAt({ x: p.x, y: L.pos.y, z: p.z }).y, ground - 50);
    return p;
};

FPV.Swarm.prototype.updateMode = function (dt, leader, env) {
    if (!leader || leader.crashed) { return; }
    const sp = FPV.len(leader.vel);
    const diving = sp > 8 && leader.vel.y / sp < -0.35;
    this.diveTime = diving ? this.diveTime + dt : 0;

    if (this.mode === 'formation' && this.diveTime > 0.3) {
        this.focus(this.predictImpact(leader, env));
    } else if (this.mode === 'support') {
        if (diving) {
            const p = this.predictImpact(leader, env);
            this.center = FPV.lerp3(this.center, p, 1 - Math.exp(-dt * 3));
        }
        const climbedOut = !diving && leader.vel.y > 2 &&
            leader.pos.y > this.center.y + this.opts.orbitMinHeight * 0.8;
        const farAway = FPV.len(FPV.horiz(FPV.sub(leader.pos, this.center))) > this.opts.orbitRadius * 4;
        if (this.time - this.supportSince > 3 && (climbedOut || farAway)) {
            this.mode = 'formation';
            this.center = null;
            this.wingmen.forEach(function (w) { if (w.role === 'orbit') { w.role = 'join'; } });
        }
    }
};

FPV.Swarm.prototype.groundBelow = function (env, p) {
    return env.floorAt({ x: p.x, y: p.y + 50, z: p.z }).y;
};

FPV.Swarm.prototype.formationCmd = function (w, idx, n, leader, env) {
    const o = this.opts;
    const L = leader;
    const hv = FPV.horiz(L.vel);
    const sp = FPV.len(hv);
    let dir = sp > 1 ? FPV.norm(hv) : FPV.norm(FPV.horiz(FPV.qRotate(L.q, { x: 0, y: 0, z: -1 })));
    if (FPV.len(dir) < 0.5) { dir = { x: 0, y: 0, z: -1 }; }
    const right = { x: -dir.z, y: 0, z: dir.x };
    const k = FPV.clamp((sp - 2) / 4, 0, 1);
    const blend = k * k * (3 - 2 * k);
    const t = this.time;

    const rank = Math.floor(idx / 2) + 1;
    const side = idx % 2 ? 1 : -1;
    const spacing = 5 + sp * 0.3;
    const wedge = FPV.add(FPV.add(FPV.scale(right, side * rank * spacing * 0.9), FPV.scale(dir, -rank * spacing * 0.7)),
        { x: 0, y: 1.5 + rank * 0.7, z: 0 });
    const ang = 2 * Math.PI * idx / Math.max(n, 1) + t * 0.15;
    const rad = 7 + n * 0.8;
    const ring = { x: Math.cos(ang) * rad, y: 3 + 0.5 * Math.sin(t * 0.8 + w.phase), z: Math.sin(ang) * rad };
    const wobble = { x: Math.sin(t * 0.7 + w.phase) * 0.6, y: Math.sin(t * 1.1 + w.phase) * 0.4, z: Math.cos(t * 0.9 + w.phase) * 0.6 };

    const slot = FPV.add(FPV.add(L.pos, FPV.lerp3(ring, wedge, blend)), wobble);
    slot.y = Math.max(slot.y, this.groundBelow(env, slot) + o.formationMinHeight);

    const toSlot = FPV.sub(slot, w.s.pos);
    const dist = FPV.len(toSlot);
    const vel = FPV.clampLen(FPV.add(L.vel, FPV.clampLen(FPV.scale(toSlot, 1.2), o.cruiseSpeed)), o.cruiseSpeed + sp);
    let face;
    if (dist > 25) { face = toSlot; }
    else if (blend > 0.5) { face = dir; }
    else { face = FPV.horiz(FPV.sub(slot, L.pos)); }
    return { vel: vel, face: face, maxTiltDeg: dist > 25 ? 65 : 50 };
};

FPV.Swarm.prototype.orbitCmd = function (w, idx, n, env) {
    const o = this.opts;
    const c = this.center;
    const t = this.time;
    const R = o.orbitRadius + 4 * Math.sin(t * 0.3 + w.phase);
    const omega = o.orbitSpeed / o.orbitRadius;
    const th = t * omega + 2 * Math.PI * idx / Math.max(n, 1);
    const groundC = Math.max(c.y, this.groundBelow(env, c));
    const slot = {
        x: c.x + Math.cos(th) * R,
        y: groundC + o.orbitMinHeight + 3 * Math.sin(t * 0.5 + w.phase),
        z: c.z + Math.sin(th) * R
    };
    slot.y = Math.max(slot.y, this.groundBelow(env, slot) + o.formationMinHeight);
    const tangent = { x: -Math.sin(th) * R * omega, y: 0, z: Math.cos(th) * R * omega };
    const vel = FPV.add(tangent, FPV.clampLen(FPV.scale(FPV.sub(slot, w.s.pos), 1.0), 30));
    return { vel: FPV.clampLen(vel, o.cruiseSpeed), face: FPV.horiz(FPV.sub(c, w.s.pos)), maxTiltDeg: 55 };
};

FPV.Swarm.prototype.attackCmd = function (w) {
    const T = w.target;
    const d = FPV.sub(T.pos, w.s.pos);
    const dist = FPV.len(d);
    const closing = Math.max(FPV.len(w.s.vel), 10);
    const tgo = Math.min(dist / closing, 3);
    const aim = FPV.add(T.pos, FPV.scale(T.vel || { x: 0, y: 0, z: 0 }, tgo));
    const dir = FPV.norm(FPV.sub(aim, w.s.pos));
    return { vel: FPV.scale(dir, this.opts.attackSpeed), face: dir, velGain: 3.5, maxTiltDeg: 80, maxAccel: 40 };
};

// Send every flying wingman (or `count` of them) at targets near the leader.
// targets: [{key, pos, vel}] - returns how many wingmen were tasked.
FPV.Swarm.prototype.attack = function (targets, leaderPos) {
    const o = this.opts;
    const inRange = targets.filter(function (t) { return FPV.dist(t.pos, leaderPos) <= o.attackRadius; });
    if (!inRange.length) { return 0; }
    const free = this.wingmen.filter(function (w) { return w.role === 'join' || w.role === 'orbit'; });
    let n = 0;
    free.forEach(function (w, i) {
        // Nearest targets first, spread round-robin across wingmen.
        const sorted = inRange.slice().sort(function (a, b) { return FPV.dist(a.pos, w.s.pos) - FPV.dist(b.pos, w.s.pos); });
        w.target = sorted[i % sorted.length];
        w.role = 'attack';
        n++;
    });
    return n;
};

FPV.Swarm.prototype.recall = function () {
    this.wingmen.forEach(function (w) { if (w.role === 'attack') { w.role = 'join'; w.target = null; } });
};

// Best airborne wingman to take over, judged by how close its camera already
// is to looking at `point`. Returns null if none qualifies.
FPV.Swarm.prototype.pickHandover = function (point) {
    let best = null;
    let bestScore = Infinity;
    const tune = this.tune;
    this.wingmen.forEach(function (w) {
        if (w.role === 'wreck' || w.role === 'attack' || w.s.crashed || w.s.onGround) { return; }
        const d = FPV.sub(point, w.s.pos);
        const dist = FPV.len(d);
        if (dist < 6 || dist > 600) { return; }
        const camF = FPV.qRotate(FPV.cameraPose(w.s, tune).q, { x: 0, y: 0, z: -1 });
        const ang = Math.acos(FPV.clamp(FPV.dot(FPV.norm(d), camF), -1, 1));
        const hd = FPV.norm(FPV.horiz(d)), hc = FPV.norm(FPV.horiz(camF));
        const yawAng = Math.acos(FPV.clamp(FPV.dot(hd, hc), -1, 1));
        const above = w.s.pos.y - point.y > 3 ? 0 : 1.5;
        const score = yawAng + ang * 0.5 + Math.abs(dist - 45) / 150 + above;
        if (score < bestScore) { bestScore = score; best = w; }
    });
    return best;
};

FPV.Swarm.prototype.aimError = function (w) {
    const camF = FPV.qRotate(FPV.cameraPose(w.s, this.tune).q, { x: 0, y: 0, z: -1 });
    return Math.acos(FPV.clamp(FPV.dot(FPV.norm(FPV.sub(w.aimPoint, w.s.pos)), camF), -1, 1));
};

function segPointDist(a, b, p) {
    const ab = FPV.sub(b, a);
    const l2 = FPV.dot(ab, ab);
    const t = l2 > 1e-9 ? FPV.clamp(FPV.dot(FPV.sub(p, a), ab) / l2, 0, 1) : 0;
    return FPV.dist(FPV.add(a, FPV.scale(ab, t)), p);
}

// Advance all wingmen. leader: controlled drone state (or null).
// targets: {key: {key,pos,vel}} currently known targets.
FPV.Swarm.prototype.update = function (dt, leader, env, targets) {
    const self = this;
    const o = this.opts;
    this.time += dt;
    this.updateMode(dt, leader, env);

    // Re-target or stand down attackers whose target vanished.
    this.wingmen.forEach(function (w) {
        if (w.role !== 'attack') { return; }
        const t = targets && targets[w.target.key];
        if (t) { w.target = t; } else { w.role = self.mode === 'support' ? 'orbit' : 'join'; w.target = null; }
    });

    const members = this.wingmen.filter(function (w) { return w.role === 'join' || w.role === 'orbit'; });
    const nullInput = { mode: 'direct', wDes: { x: 0, y: 0, z: 0 }, thrustCmd: 0 };

    const prev = {};
    this.wingmen.forEach(function (w) {
        prev[w.id] = { x: w.s.pos.x, y: w.s.pos.y, z: w.s.pos.z };
        w.cmd = null;
        if (w.role === 'wreck' || w.s.crashed) { return; }
        const idx = members.indexOf(w);
        if (w.role === 'attack') { w.cmd = self.attackCmd(w); }
        else if (w.role === 'aim') { w.cmd = { aimCamera: true, face: FPV.sub(w.aimPoint, w.s.pos), aimThrust: 0.22 }; }
        else if (self.mode === 'support' && self.center) { w.role = 'orbit'; w.cmd = self.orbitCmd(w, idx, members.length, env); }
        else if (leader) { w.role = 'join'; w.cmd = self.formationCmd(w, idx, members.length, leader, env); }
        else { w.cmd = { vel: { x: 0, y: 0, z: 0 }, face: null }; }
    });

    this.acc += dt;
    while (this.acc >= FPV.SWARM_STEP) {
        this.acc -= FPV.SWARM_STEP;
        this.wingmen.forEach(function (w) {
            const input = w.cmd && !w.s.crashed ? FPV.autopilot(w.s, w.cmd, self.tune) : nullInput;
            FPV.step(w.s, input, env, self.tune, FPV.SWARM_STEP);
        });
    }

    const keep = [];
    this.wingmen.forEach(function (w) {
        w.age += dt;
        if (w.role === 'attack' && !w.s.crashed &&
            segPointDist(prev[w.id], w.s.pos, w.target.pos) <= o.hitRadius) {
            const speed = FPV.len(w.s.vel);
            FPV.crash(w.s, 'IMPACT');
            w.hit = true;
            self.events.push({ type: 'impact', id: w.id, pos: w.target.pos, speed: speed, target: w.target.key });
        }
        while (w.s.events.length) {
            const ev = w.s.events.shift();
            if (ev.type !== 'crash' || w.role === 'wreck') { continue; }
            if (!w.hit) {
                self.events.push({ type: 'lost', id: w.id, reason: ev.reason, pos: w.s.pos });
                if (ev.speed >= o.impactMinSpeed && ev.reason !== 'WATER' && ev.reason !== 'HIT') {
                    self.events.push({ type: 'impact', id: w.id, pos: w.s.pos, speed: ev.speed, target: null });
                }
            }
            w.role = 'wreck';
            w.age = 0;
            w.target = null;
        }
        if (!(w.role === 'wreck' && w.age > o.wreckSeconds)) { keep.push(w); }
    });
    this.wingmen = keep;
};
