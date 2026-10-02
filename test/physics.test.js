'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FPV = require('./load').loadPure();

const DT = 1 / 240;
const flat = { floorAt: () => ({ y: 1000, water: false }) };
const sea = { floorAt: () => ({ y: 1024, water: true }) };

function sim(s, input, env, tune, seconds) {
    for (let t = 0; t < seconds; t += DT) { FPV.step(s, input, env, tune, DT); }
    return s;
}

function close(a, b, eps, msg) {
    assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} got ${a}`);
}

test('quaternion rotate / euler round trip for every order', () => {
    const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];
    const e = { x: 0.3, y: -1.1, z: 0.7 };
    for (const o of orders) {
        const q = FPV.quatFromEuler(e, o);
        const back = FPV.eulerFromQuat(q, o);
        close(back.x, e.x, 1e-9, o + ' x');
        close(back.y, e.y, 1e-9, o + ' y');
        close(back.z, e.z, 1e-9, o + ' z');
    }
    const q = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const f = FPV.qRotate(q, { x: 0, y: 0, z: -1 });   // forward rotated 90 deg left
    close(f.x, -1, 1e-9); close(f.z, 0, 1e-9);
});

test('JC3 yaw convention: positive game yaw faces east', () => {
    const cam = { eulerOrder: 'YXZ', pitchSign: -1, yawSign: -1, rollSign: -1 };
    const q = FPV.fromGameYaw(Math.PI / 2, cam);
    const fwd = FPV.qRotate(q, { x: 0, y: 0, z: -1 });
    close(fwd.x, 1, 1e-9, 'east'); // matches freecam: forward = (sin y, 0, -cos y)
    const back = FPV.toGameEuler(q, cam);
    close(back.y, Math.PI / 2, 1e-9);
});

test('betaflight rates match known values', () => {
    const r = { rcRate: 1.0, superRate: 0.7, expo: 0 };
    close(FPV.bfRate(1, r), 666.67, 0.1, 'full stick');
    close(FPV.bfRate(0, r), 0, 1e-9);
    close(FPV.bfRate(-1, r), -666.67, 0.1);
    close(FPV.bfRate(1, { rcRate: 1, superRate: 0, expo: 0 }), 200, 1e-9);
});

test('throttle curve is identity with zero expo and monotonic with expo', () => {
    close(FPV.throttleCurve(0.3, 0.5, 0), 0.3, 1e-9);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = FPV.throttleCurve(t, 0.4, 0.6);
        assert.ok(v >= prev, 'monotonic');
        prev = v;
    }
});

test('disarmed quad rests on the floor', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 1000.15, z: 0 });
    sim(s, { throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 2);
    close(s.pos.y, 1000 + tune.collisionRadius, 1e-6);
    assert.strictEqual(s.crashed, false);
});

test('armed quad climbs at full throttle and hovers near the hover point', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    tune.battery.enabled = false;
    const s = FPV.createState({ x: 0, y: 1000.15, z: 0 });
    assert.strictEqual(FPV.tryArm(s, { throttle: 0, mode: 'acro' }), '');
    sim(s, { throttle: 1, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 1);
    assert.ok(s.pos.y > 1010, 'climbed ' + s.pos.y);

    // thrust ~ motor^2, so hover motor = sqrt(1/twr); throttle = (motor - idle) / (1 - idle)
    const hoverMotor = Math.sqrt(1 / tune.thrustToWeight);
    const hover = (hoverMotor - tune.idleThrottle) / (1 - tune.idleThrottle);
    assert.ok(hover > 0.2 && hover < 0.4, 'hover throttle is in a usable range: ' + hover);
    const h = FPV.createState({ x: 0, y: 1100, z: 0 });
    h.armed = true;
    h.motor = hoverMotor;
    sim(h, { throttle: hover, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 3);
    close(h.vel.y, 0, 0.05, 'hover vertical speed');
});

test('acro roll input produces the commanded rate and the right direction', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 1100, z: 0 });
    s.armed = true;
    sim(s, { throttle: 0.3, roll: 0.5, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 0.15);
    const expected = FPV.bfRate(0.5, tune.rates.roll) * FPV.DEG;
    close(-s.w.z, expected, expected * 0.02, 'roll rate');
    // rolling right lowers the right side: body +X now points downward
    const right = FPV.qRotate(s.q, { x: 1, y: 0, z: 0 });
    assert.ok(right.y < 0, 'right wing dips');
});

test('angle mode self-levels and holds the commanded tilt', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    tune.battery.enabled = false;
    const s = FPV.createState({ x: 0, y: 1100, z: 0 }, FPV.qAxisAngle({ x: 0, y: 0, z: 1 }, 1.0));
    s.armed = true;
    sim(s, { throttle: 0.2, roll: 0, pitch: 0, yaw: 0, mode: 'angle' }, flat, tune, 1.5);
    const up = FPV.qRotate(s.q, { x: 0, y: 1, z: 0 });
    assert.ok(up.y > 0.995, 'levelled, up.y=' + up.y);

    sim(s, { throttle: 0.2, roll: 0, pitch: 1, yaw: 0, mode: 'angle' }, flat, tune, 1.5);
    const fwd = FPV.qRotate(s.q, { x: 0, y: 0, z: -1 });
    close(Math.asin(-fwd.y), tune.angleMaxDeg * FPV.DEG, 0.03, 'nose-down angle');
});

test('alt-hold assist holds altitude with centred throttle', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    tune.battery.enabled = false;
    const s = FPV.createState({ x: 0, y: 1100, z: 0 });
    s.armed = true;
    sim(s, { throttle: 0.5, roll: 0, pitch: 0.4, yaw: 0, mode: 'angle', altHold: true }, flat, tune, 4);
    close(s.vel.y, 0, 0.3, 'vertical speed');
    assert.ok(Math.abs(s.pos.y - 1100) < 3, 'altitude ' + s.pos.y);
});

test('forward flight reaches a sane top speed', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    tune.battery.enabled = false;
    const s = FPV.createState({ x: 0, y: 1500, z: 0 }, FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, -1.2));
    s.armed = true;
    sim(s, { throttle: 1, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 8);
    const kmh = FPV.len(s.vel) * 3.6;
    assert.ok(kmh > 170 && kmh < 260, 'top speed ' + kmh.toFixed(1) + ' km/h');
});

test('hard impact crashes and disarms; water is fatal', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 1005, z: 0 });
    s.armed = true;
    s.vel = { x: 0, y: -20, z: 0 };
    sim(s, { throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 3);
    assert.strictEqual(s.crashed, true);
    assert.strictEqual(s.armed, false);
    assert.strictEqual(s.crashReason, 'IMPACT');
    assert.strictEqual(FPV.tryArm(s, { throttle: 0, mode: 'acro' }), '', 'can re-arm on land');

    const w = FPV.createState({ x: 0, y: 1030, z: 0 });
    sim(w, { throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, sea, tune, 3);
    assert.strictEqual(w.crashReason, 'WATER');
    assert.strictEqual(FPV.tryArm(w, { throttle: 0, mode: 'acro' }), 'WATER');
});

test('arming is refused with throttle up', () => {
    const s = FPV.createState({ x: 0, y: 0, z: 0 });
    assert.strictEqual(FPV.tryArm(s, { throttle: 0.5, mode: 'acro' }), 'THROTTLE');
    assert.strictEqual(FPV.tryArm(s, { throttle: 0.5, mode: 'angle', altHold: true }), '');
});

test('battery drains and sags under load', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 3000, z: 0 });
    s.armed = true;
    sim(s, { throttle: 1, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 5);
    assert.ok(s.usedMah > 100, 'used ' + s.usedMah);
    assert.ok(s.cellVoltage < 3.95, 'sagged to ' + s.cellVoltage);
});

test('mergeTune ignores unknown keys and bad types', () => {
    const t = FPV.cloneTune(FPV.DEFAULT_TUNE);
    FPV.mergeTune(t, { thrustToWeight: 9, massKg: 'heavy', bogus: 1, rates: { roll: { rcRate: 1.5 } }, crashSpeed: NaN });
    assert.strictEqual(t.thrustToWeight, 9);
    assert.strictEqual(t.massKg, 0.65);
    assert.strictEqual(t.rates.roll.rcRate, 1.5);
    assert.strictEqual(t.crashSpeed, 8);
    assert.strictEqual(t.bogus, undefined);
});

test('camera pose applies uptilt', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 0, z: 0 });
    const cam = FPV.cameraPose(s, tune);
    const fwd = FPV.qRotate(cam.q, { x: 0, y: 0, z: -1 });
    close(Math.asin(fwd.y), tune.cameraTiltDeg * FPV.DEG, 1e-9, 'uptilt');
});

test('true acro: centred sticks hold the current attitude (no self-levelling)', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const s = FPV.createState({ x: 0, y: 2000, z: 0 }, FPV.qAxisAngle({ x: 0, y: 0, z: 1 }, 0.8));
    s.armed = true;
    sim(s, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, flat, tune, 2);
    const right = FPV.qRotate(s.q, { x: 1, y: 0, z: 0 });
    close(Math.asin(right.y), 0.8, 0.01, 'still banked');
});

test('solid points: slow contact slides, fast contact crashes', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    const wall = { floorAt: () => ({ y: 1000, water: false }),
        collide: (p, r) => (p.x + r > 10 ? { normal: { x: -1, y: 0, z: 0 }, depth: p.x + r - 10 } : null) };
    const slow = FPV.createState({ x: 8, y: 1050, z: 0 });
    slow.armed = true; slow.motor = Math.sqrt(1 / tune.thrustToWeight);
    slow.vel = { x: 4, y: 0, z: 0 };
    sim(slow, { throttle: 0.27, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, wall, tune, 1.5);
    assert.strictEqual(slow.crashed, false, 'bumped, not broken');
    assert.ok(slow.pos.x <= 10, 'did not pass through: ' + slow.pos.x);
    const fast = FPV.createState({ x: 0, y: 1050, z: 0 });
    fast.armed = true;
    fast.vel = { x: 30, y: 0, z: 0 };
    sim(fast, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0, mode: 'acro' }, wall, tune, 1);
    assert.strictEqual(fast.crashReason, 'IMPACT');
    assert.ok(fast.pos.x <= 10, 'stopped at the wall: ' + fast.pos.x);
});
