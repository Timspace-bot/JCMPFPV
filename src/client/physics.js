// ---------------------------------------------------------------------------
// physics.js - a small rigid-body quadcopter model with a Betaflight-style
// rate controller. Pure JS, no game API calls: the client feeds it stick input
// and an environment (floor height lookup) and reads back position/attitude.
// ---------------------------------------------------------------------------

// Defaults approximate a 5" 4S freestyle quad. All of these can be overridden
// from the in-game settings panel or the server config.
FPV.DEFAULT_TUNE = {
    massKg: 0.65,
    gravity: 9.81,
    thrustToWeight: 10.0,    // punchy: Medici is big
    motorTau: 0.03,          // s, motor/prop spool time constant
    rateTau: 0.022,          // s, how quickly the PID loop reaches the commanded rate
    idleThrottle: 0.10,      // airmode idle - motor (rpm) fraction while armed at zero throttle
    dragLinear: 0.015,       // N per m/s
    dragBody: { x: 0.008, y: 0.040, z: 0.0058 }, // quadratic, N per (m/s)^2, body axes
    rates: {
        roll: { rcRate: 1.0, superRate: 0.70, expo: 0.0 },
        pitch: { rcRate: 1.0, superRate: 0.70, expo: 0.0 },
        yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 }
    },
    throttleMid: 0.5,
    throttleExpo: 0.0,
    angleMaxDeg: 55,
    angleGain: 8.0,          // rad/s of correction per rad of attitude error
    altHoldMaxClimb: 6.0,    // m/s at full stick in "assist" throttle mode
    altHoldGain: 3.0,
    cameraTiltDeg: 25,
    cameraOffset: { x: 0, y: 0.03, z: -0.06 },
    collisionRadius: 0.15,
    crashSpeed: 8.0,         // m/s impact speed that breaks the quad
    groundFriction: 6.0,
    battery: { enabled: true, cells: 6, capacityMah: 2200, maxCurrentA: 150 }
};

FPV.cloneTune = function (t) { return JSON.parse(JSON.stringify(t)); };

// Recursively copies known keys from `src` onto `dst` (ignores unknown keys and
// type mismatches so a stale/garbled settings blob cannot break the model).
FPV.mergeTune = function (dst, src) {
    if (!src || typeof src !== 'object') { return dst; }
    for (const k in dst) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) { continue; }
        if (dst[k] && typeof dst[k] === 'object') {
            FPV.mergeTune(dst[k], src[k]);
        } else if (typeof dst[k] === typeof src[k]) {
            if (typeof src[k] === 'number' && !isFinite(src[k])) { continue; }
            dst[k] = src[k];
        }
    }
    return dst;
};

// Betaflight "actual" rate curve (RC rate / super rate / expo) -> deg/s.
FPV.bfRate = function (stick, r) {
    let rc = FPV.clamp(stick, -1, 1);
    const abs = Math.abs(rc);
    if (r.expo) { rc = rc * abs * abs * abs * r.expo + rc * (1 - r.expo); }
    let rcRate = r.rcRate;
    if (rcRate > 2) { rcRate += 14.54 * (rcRate - 2); }
    let rate = 200 * rcRate * rc;
    if (r.superRate) { rate *= 1 / FPV.clamp(1 - abs * r.superRate, 0.01, 1); }
    return FPV.clamp(rate, -1998, 1998);
};

// Betaflight throttle mid/expo curve, 0..1 -> 0..1.
FPV.throttleCurve = function (thr, mid, expo) {
    thr = FPV.clamp(thr, 0, 1);
    const tmp = thr - mid;
    const range = tmp > 0 ? 1 - mid : mid;
    if (range <= 0) { return thr; }
    return FPV.clamp(mid + tmp * (1 - expo + expo * (tmp * tmp) / (range * range)), 0, 1);
};

FPV.createState = function (pos, q) {
    return {
        pos: FPV.v3(pos.x, pos.y, pos.z),
        vel: FPV.v3(),
        q: q ? FPV.qNorm(q) : FPV.qIdentity(),
        w: FPV.v3(),            // body rates rad/s (x pitch-up, y yaw-left, z roll-left)
        motor: 0,               // actual thrust fraction 0..1
        armed: false,
        crashed: false,
        crashReason: '',
        onGround: false,
        inWater: false,
        usedMah: 0,
        cellVoltage: 4.2,
        currentA: 0,
        flightTime: 0,
        maxSpeed: 0,
        events: []
    };
};

FPV.yawOf = function (q) {
    return FPV.eulerFromQuat(q, 'YXZ').y;
};

// Desired body rates (rad/s) for the current stick input and flight mode.
FPV.desiredRates = function (s, input, tune) {
    if (input.mode === 'direct') { return input.wDes; }   // autopilot (swarm wingmen)
    const R = tune.rates;
    const acro = {
        x: -FPV.bfRate(input.pitch, R.pitch) * FPV.DEG,  // stick forward -> nose down
        y: -FPV.bfRate(input.yaw, R.yaw) * FPV.DEG,      // stick right  -> yaw right
        z: -FPV.bfRate(input.roll, R.roll) * FPV.DEG     // stick right  -> roll right
    };
    if (input.mode === 'acro') { return acro; }

    // Self-levelling: target attitude = current heading tilted by stick angle.
    const maxA = tune.angleMaxDeg * FPV.DEG;
    const heading = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(s.q));
    const tilt = FPV.qMul(
        FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, -input.pitch * maxA),
        FPV.qAxisAngle({ x: 0, y: 0, z: 1 }, -input.roll * maxA));
    const target = FPV.qMul(heading, tilt);
    let err = FPV.qMul(FPV.qConj(s.q), target);
    if (err.w < 0) { err = { x: -err.x, y: -err.y, z: -err.z, w: -err.w }; }
    const aa = FPV.qToAxisAngle(err);
    const level = {
        x: aa.axis.x * aa.angle * tune.angleGain,
        y: acro.y,
        z: aa.axis.z * aa.angle * tune.angleGain
    };
    if (input.mode === 'angle') { return level; }

    // Horizon: level near centre stick, acro at full deflection.
    const k = FPV.clamp(Math.max(Math.abs(input.roll), Math.abs(input.pitch)), 0, 1);
    return {
        x: level.x * (1 - k) + acro.x * k,
        y: acro.y,
        z: level.z * (1 - k) + acro.z * k
    };
};

FPV.motorCommand = function (s, input, tune) {
    if (!s.armed || s.crashed) { return 0; }
    // s.motor is a motor speed fraction; props make thrust ~ speed^2, so
    // thrust targets (autopilot, altitude assist) go through a square root.
    if (input.mode === 'direct') { return FPV.clamp(Math.sqrt(Math.max(input.thrustCmd, 0)), tune.idleThrottle, 1); }
    const thrust = FPV.throttleCurve(input.throttle, tune.throttleMid, tune.throttleExpo);
    if (input.altHold && input.mode !== 'acro') {
        // Throttle stick commands a climb rate; centre stick = hover.
        const up = FPV.qRotate(s.q, { x: 0, y: 1, z: 0 });
        const tiltCos = Math.max(up.y, 0.3);
        const vzTarget = (FPV.clamp(input.throttle, 0, 1) - 0.5) * 2 * tune.altHoldMaxClimb;
        const accel = tune.gravity + tune.altHoldGain * (vzTarget - s.vel.y);
        const maxAccel = tune.thrustToWeight * tune.gravity;
        return FPV.clamp(Math.sqrt(Math.max(accel / (maxAccel * tiltCos), 0)), tune.idleThrottle, 1);
    }
    return tune.idleThrottle + (1 - tune.idleThrottle) * thrust;
};

FPV.updateBattery = function (s, tune, dt) {
    const b = tune.battery;
    if (!b.enabled) { s.cellVoltage = 4.2; s.currentA = 0; return 1; }
    s.currentA = 0.8 + b.maxCurrentA * s.motor * s.motor * s.motor;   // power ~ rpm^3
    s.usedMah += s.currentA * dt / 3.6;
    const charge = FPV.clamp(1 - s.usedMah / b.capacityMah, 0, 1);
    // Rough LiPo curve: 4.2V full, plateau ~3.8V, knee below 3.5V.
    const rest = 3.3 + 0.9 * Math.pow(charge, 0.6);
    const packSag = s.currentA * 0.012;              // ~12 mOhm pack resistance
    s.cellVoltage = Math.max(2.8, rest - packSag / b.cells);
    if (charge <= 0) { return 0.3; }
    return 0.75 + 0.25 * FPV.clamp((rest - 3.3) / 0.9, 0, 1);
};

// Aerodynamic drag (world frame, Newtons) for attitude q moving at vel.
FPV.dragForce = function (q, vel, tune) {
    const vb = FPV.qRotate(FPV.qConj(q), vel);
    const db = tune.dragBody;
    return FPV.qRotate(q, {
        x: -db.x * Math.abs(vb.x) * vb.x - tune.dragLinear * vb.x,
        y: -db.y * Math.abs(vb.y) * vb.y - tune.dragLinear * vb.y,
        z: -db.z * Math.abs(vb.z) * vb.z - tune.dragLinear * vb.z
    });
};

FPV.crash = function (s, reason) {
    if (s.crashed) { return; }
    s.crashed = true;
    s.armed = false;
    s.crashReason = reason;
    s.events.push({ type: 'crash', reason: reason, speed: FPV.len(s.vel) });
};

// Advance the simulation by dt seconds.
//   input: {throttle 0..1, roll/pitch/yaw -1..1, mode 'acro'|'angle'|'horizon', altHold}
//   env:   {floorAt(pos) -> {y, water}}
FPV.step = function (s, input, env, tune, dt) {
    const m = tune.massKg;
    const g = tune.gravity;

    // --- rotation -----------------------------------------------------------
    if (s.armed && !s.crashed) {
        const des = FPV.desiredRates(s, input, tune);
        const k = 1 - Math.exp(-dt / tune.rateTau);
        s.w = FPV.add(s.w, FPV.scale(FPV.sub(des, s.w), k));
    } else if (!s.onGround) {
        // Unpowered tumble: props windmill and slowly damp rotation.
        s.w = FPV.scale(s.w, Math.exp(-dt * 0.8));
    }

    // --- motors / battery ---------------------------------------------------
    const cmd = FPV.motorCommand(s, input, tune);
    s.motor += (cmd - s.motor) * (1 - Math.exp(-dt / tune.motorTau));
    const battFactor = FPV.updateBattery(s, tune, dt);

    // --- forces -------------------------------------------------------------
    const maxThrust = tune.thrustToWeight * m * g;
    const up = FPV.qRotate(s.q, { x: 0, y: 1, z: 0 });
    let force = FPV.scale(up, s.motor * s.motor * maxThrust * battFactor);
    force.y -= m * g;

    force = FPV.add(force, FPV.dragForce(s.q, s.vel, tune));

    // --- integrate (semi-implicit Euler) -------------------------------------
    s.vel = FPV.add(s.vel, FPV.scale(force, dt / m));
    s.pos = FPV.add(s.pos, FPV.scale(s.vel, dt));
    s.q = FPV.qIntegrateBody(s.q, s.w, dt);

    // --- ground / water -----------------------------------------------------
    const floor = env.floorAt(s.pos);
    const r = tune.collisionRadius;
    s.inWater = false;
    if (s.pos.y - r <= floor.y) {
        const impact = -s.vel.y;
        const horiz = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
        if (floor.water) {
            s.inWater = true;
            FPV.crash(s, 'WATER');
            s.pos.y = floor.y - r * 0.5;
            s.vel = FPV.scale(s.vel, 0.2);
            s.w = FPV.v3();
        } else {
            if (impact > tune.crashSpeed || horiz > tune.crashSpeed * 2.5) {
                FPV.crash(s, 'IMPACT');
            }
            s.pos.y = floor.y + r;
            if (s.vel.y < 0) { s.vel.y = 0; }
            if (!s.armed || s.motor < 0.3) {
                const f = Math.exp(-dt * tune.groundFriction);
                s.vel.x *= f; s.vel.z *= f;
                // Settle flat on the ground keeping heading.
                s.w = FPV.v3();
                s.q = FPV.qSlerp(s.q, FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(s.q)), 1 - Math.exp(-dt * 10));
            }
        }
        s.onGround = true;
    } else {
        s.onGround = false;
    }

    // --- everything else the world knows is solid (walls, trees, rocks) -----
    if (env.collide) {
        const c = env.collide(s.pos, r);
        if (c) {
            s.pos = FPV.add(s.pos, FPV.scale(c.normal, c.depth));
            const vn = FPV.dot(s.vel, c.normal);
            if (vn < 0) {
                if (-vn > tune.crashSpeed && !s.crashed) {
                    FPV.crash(s, 'IMPACT');
                    s.events[s.events.length - 1].speed = -vn;
                }
                // Remove the inward part (with a little bounce), scrub some slide.
                s.vel = FPV.scale(FPV.sub(s.vel, FPV.scale(c.normal, vn * 1.3)), 0.92);
            }
            if (c.normal.y > 0.7) { s.onGround = true; }
        }
    }

    if (s.armed) { s.flightTime += dt; }
    const speed = FPV.len(s.vel);
    if (speed > s.maxSpeed) { s.maxSpeed = speed; }
    return s;
};

// Arming checks, mirroring a real flight controller. Returns '' on success or
// the reason arming was refused.
FPV.tryArm = function (s, input) {
    if (s.armed) { return ''; }
    if (input.throttle > 0.06 && !(input.altHold && input.mode !== 'acro')) { return 'THROTTLE'; }
    if (input.altHold && input.mode !== 'acro' && input.throttle > 0.55) { return 'THROTTLE'; }
    if (s.inWater) { return 'WATER'; }
    s.crashed = false;
    s.crashReason = '';
    s.armed = true;
    s.events.push({ type: 'arm' });
    return '';
};

FPV.disarm = function (s) {
    if (!s.armed) { return; }
    s.armed = false;
    s.events.push({ type: 'disarm' });
};

FPV.cameraPose = function (s, tune) {
    const tilt = FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, tune.cameraTiltDeg * FPV.DEG);
    return {
        pos: FPV.add(s.pos, FPV.qRotate(s.q, tune.cameraOffset)),
        q: FPV.qMul(s.q, tilt)
    };
};
