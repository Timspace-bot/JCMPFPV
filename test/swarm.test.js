'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FPV = require('./load').loadPure();

const ground = { floorAt: (p) => ({ y: 1000, water: false }) };

function leaderState(pos, vel) {
    const s = FPV.createState(pos);
    s.armed = true;
    s.vel = vel || { x: 0, y: 0, z: 0 };
    return s;
}

function run(swarm, leader, seconds, targets, moveLeader) {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
        if (moveLeader) { leader.pos = FPV.add(leader.pos, FPV.scale(leader.vel, dt)); }
        swarm.update(dt, leader, ground, targets || {});
    }
}

test('autopilot holds a hover and tracks a velocity', () => {
    const tune = FPV.cloneTune(FPV.DEFAULT_TUNE);
    tune.battery.enabled = false;
    const s = FPV.createState({ x: 0, y: 1100, z: 0 });
    s.armed = true;
    for (let i = 0; i < 240 * 3; i++) {
        FPV.step(s, FPV.autopilot(s, { vel: { x: 0, y: 0, z: 0 }, face: { x: 0, y: 0, z: -1 } }, tune), ground, tune, 1 / 240);
    }
    assert.ok(FPV.len(s.vel) < 0.2, 'hover drift ' + FPV.len(s.vel));
    for (let i = 0; i < 240 * 4; i++) {
        FPV.step(s, FPV.autopilot(s, { vel: { x: 20, y: 0, z: 0 }, face: { x: 1, y: 0, z: 0 } }, tune), ground, tune, 1 / 240);
    }
    assert.ok(Math.abs(s.vel.x - 20) < 1.5 && Math.abs(s.vel.y) < 1.5, 'tracks 20 m/s east: ' + JSON.stringify(s.vel));
    const fwd = FPV.qRotate(s.q, { x: 0, y: 0, z: -1 });
    assert.ok(fwd.x > 0.8, 'nose points east');
});

test('called wingman takes off from the pad and joins the formation', () => {
    const swarm = new FPV.Swarm({}, FPV.DEFAULT_TUNE);
    const leader = leaderState({ x: 100, y: 1040, z: 0 });
    const w = swarm.spawn({ x: 0, y: 1000.15, z: 0 }, FPV.qIdentity());
    assert.ok(w);
    run(swarm, leader, 12);
    const d = FPV.dist(w.s.pos, leader.pos);
    assert.ok(d < 15, 'within formation distance: ' + d.toFixed(1));
    assert.ok(w.s.pos.y > 1000 + swarm.opts.formationMinHeight - 0.5, 'above minimum height');
    assert.strictEqual(w.s.crashed, false);
});

test('formation follows a moving leader as a wedge behind it', () => {
    const swarm = new FPV.Swarm({}, FPV.DEFAULT_TUNE);
    const leader = leaderState({ x: 0, y: 1050, z: 0 }, { x: 0, y: 0, z: -15 });
    const ws = [0, 1, 2, 3].map((i) => swarm.spawn({ x: i * 3, y: 1050, z: 10 }, FPV.qIdentity()));
    ws.forEach((w) => { w.s.onGround = false; });
    run(swarm, leader, 15, {}, true);
    ws.forEach((w) => {
        assert.ok(w.s.pos.z > leader.pos.z, 'behind the leader');
        assert.ok(FPV.dist(w.s.pos, leader.pos) < 30, 'keeping up: ' + FPV.dist(w.s.pos, leader.pos).toFixed(1));
        assert.ok(Math.abs(w.s.vel.z + 15) < 3, 'matching speed');
    });
    // Wingmen do not collide with each other's slots.
    for (let i = 0; i < ws.length; i++) {
        for (let j = i + 1; j < ws.length; j++) { assert.ok(FPV.dist(ws[i].s.pos, ws[j].s.pos) > 2, 'separated'); }
    }
});

test('a diving leader puts the swarm into an orbit above the target', () => {
    const swarm = new FPV.Swarm({}, FPV.DEFAULT_TUNE);
    const leader = leaderState({ x: 0, y: 1080, z: 0 });
    const ws = [0, 1, 2].map((i) => swarm.spawn({ x: i * 4, y: 1080, z: 0 }, FPV.qIdentity()));
    ws.forEach((w) => { w.s.onGround = false; });
    run(swarm, leader, 4);
    leader.vel = { x: 10, y: -20, z: 0 };       // steep dive
    run(swarm, leader, 1.2, {}, true);
    assert.strictEqual(swarm.mode, 'support');
    leader.crashed = true;
    swarm.focus({ x: 40, y: 1000, z: 0 });
    run(swarm, null, 20);
    ws.forEach((w) => {
        const r = FPV.len(FPV.horiz(FPV.sub(w.s.pos, swarm.center)));
        assert.strictEqual(w.role, 'orbit');
        assert.ok(Math.abs(r - swarm.opts.orbitRadius) < 10, 'orbit radius ' + r.toFixed(1));
        assert.ok(w.s.pos.y - 1000 > swarm.opts.orbitMinHeight - 6, 'min height ' + (w.s.pos.y - 1000).toFixed(1));
        assert.ok(FPV.len(FPV.horiz(w.s.vel)) > 5, 'circling, not hovering');
    });
});

test('handover picks a wingman looking at the crash point and aims its camera there', () => {
    const swarm = new FPV.Swarm({}, FPV.DEFAULT_TUNE);
    const point = { x: 0, y: 1000, z: 0 };
    // One facing the point, one facing away.
    const good = swarm.spawn({ x: 0, y: 1025, z: 40 }, FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, 0));        // looks -Z (towards point)
    const bad = swarm.spawn({ x: 0, y: 1025, z: -40 }, FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, 0));       // looks -Z (away)
    good.s.onGround = false; bad.s.onGround = false;
    assert.strictEqual(swarm.pickHandover(point), good);

    good.role = 'aim';
    good.aimPoint = point;
    const err0 = swarm.aimError(good);
    run(swarm, null, 0.8);
    assert.ok(swarm.aimError(good) < 6 * FPV.DEG, 'camera on target: ' + (swarm.aimError(good) / FPV.DEG).toFixed(1) + ' deg (was ' + (err0 / FPV.DEG).toFixed(1) + ')');
});

test('attack command sends wingmen into targets in range and reports impacts', () => {
    const swarm = new FPV.Swarm({}, FPV.DEFAULT_TUNE);
    const leader = leaderState({ x: 0, y: 1050, z: 0 });
    const ws = [0, 1].map((i) => swarm.spawn({ x: i * 5, y: 1050, z: 5 }, FPV.qIdentity()));
    ws.forEach((w) => { w.s.onGround = false; });
    const targets = {
        car: { key: 'car', pos: { x: 60, y: 1001, z: -40 }, vel: { x: 0, y: 0, z: 0 } },
        far: { key: 'far', pos: { x: 900, y: 1001, z: 0 }, vel: { x: 0, y: 0, z: 0 } }
    };
    assert.strictEqual(swarm.attack(Object.values(targets), leader.pos), 2);
    assert.ok(ws.every((w) => w.target.key === 'car'), 'only the in-range target is chosen');
    run(swarm, leader, 8, targets);
    const impacts = swarm.events.filter((e) => e.type === 'impact');
    assert.strictEqual(impacts.length, 2, JSON.stringify(swarm.events));
    assert.ok(impacts.every((e) => e.target === 'car' && e.speed > 15));
    assert.ok(ws.every((w) => w.role === 'wreck'));
});

test('attack with no targets in range does nothing; wrecks expire', () => {
    const swarm = new FPV.Swarm({ wreckSeconds: 2 }, FPV.DEFAULT_TUNE);
    const leader = leaderState({ x: 0, y: 1050, z: 0 });
    const w = swarm.spawn({ x: 0, y: 1050, z: 5 }, FPV.qIdentity());
    assert.strictEqual(swarm.attack([{ key: 'x', pos: { x: 5000, y: 0, z: 0 } }], leader.pos), 0);
    assert.strictEqual(w.role, 'join');
    swarm.wreck(FPV.createState({ x: 0, y: 1000.2, z: 0 }), 99);
    run(swarm, leader, 3);
    assert.ok(!swarm.wingmen.some((x) => x.id === 99), 'wreck removed');
});

test('max wingmen is enforced', () => {
    const swarm = new FPV.Swarm({ maxWingmen: 2 }, FPV.DEFAULT_TUNE);
    assert.ok(swarm.spawn({ x: 0, y: 0, z: 0 }));
    assert.ok(swarm.spawn({ x: 0, y: 0, z: 0 }));
    assert.strictEqual(swarm.spawn({ x: 0, y: 0, z: 0 }), null);
});
