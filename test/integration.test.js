'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../tools/build.js').build();
const { Server, Vector3f } = require('./harness');

// Most scenarios fly like an RC pilot in acro (the shipped default for new
// pilots is angle + altitude assist, covered by the keyboard tests below).
function setup(opts) {
    const server = new Server();
    const a = server.connect('Alice');
    const b = server.connect('Bob');
    a.ui('fpv/ui/ready');
    b.ui('fpv/ui/ready');
    if (!opts || !opts.defaults) {
        a.ui('fpv/ui/settings', JSON.stringify({ mode: 'acro', altHold: false }));
    }
    return { server, a, b };
}

function sticks(c, t, roll, pitch, yaw) {
    c.hold(t, roll, pitch, yaw);
}

test('launch, arm, fly, relay to other players, land', () => {
    const { server, a, b } = setup();
    const launchY = a.player.position.y;

    a.ui('fpv/ui/cmd', 'toggle');
    assert.strictEqual(a.lp.camera.attachedToPlayer, false, 'camera detached');
    assert.strictEqual(a.lp.frozen, true, 'character frozen');
    assert.strictEqual(a.player.invulnerable, true, 'invulnerable while flying');
    assert.deepStrictEqual(a.lastUi('fpv/active'), [true]);

    // Sitting on the launch pad, disarmed: must not fall to sea level.
    sticks(a, 0);
    server.run(1);
    assert.ok(Math.abs(a.lp.camera.position.y - launchY) < 1, 'resting on pad, cam y=' + a.lp.camera.position.y);

    // Arming with throttle up is refused, with throttle down accepted.
    sticks(a, 0.6);
    a.ui('fpv/ui/cmd', 'arm');
    let osd = JSON.parse(a.lastUi('fpv/osd')[0]);
    server.run(0.1);
    osd = JSON.parse(a.lastUi('fpv/osd')[0]);
    assert.strictEqual(osd.armed, false);
    assert.strictEqual(osd.blocked, 'THROTTLE');
    sticks(a, 0);
    a.ui('fpv/ui/cmd', 'arm');
    server.run(0.1);
    osd = JSON.parse(a.lastUi('fpv/osd')[0]);
    assert.strictEqual(osd.armed, true);

    // Punch out.
    sticks(a, 0.9);
    server.run(2);
    osd = JSON.parse(a.lastUi('fpv/osd')[0]);
    assert.ok(osd.alt > 15, 'climbed to ' + osd.alt);
    assert.ok(a.lp.camera.position.y > launchY + 15, 'camera follows drone');
    assert.ok(isFinite(a.lp.camera.rotation.x) && isFinite(a.lp.camera.rotation.y));

    // Bob sees Alice's drone (3D model + name tag).
    const r = server.run(0.5).b || server.run(0.1)[b.player.networkId];
    const rb = b.frame();
    assert.ok(rb.draws >= 2, 'remote drone drawn, draws=' + rb.draws);
    assert.ok(rb.texts >= 1, 'name tag drawn');

    // Yaw / roll inputs change the camera.
    const before = a.lp.camera.rotation.y;
    sticks(a, 0.5, 0, 0, 0.5);
    server.run(0.3);
    assert.notStrictEqual(a.lp.camera.rotation.y, before, 'yawing');

    // Exit.
    a.ui('fpv/ui/cmd', 'toggle');
    assert.strictEqual(a.lp.camera.attachedToPlayer, true);
    assert.strictEqual(a.lp.frozen, false);
    assert.strictEqual(a.lp.camera.fieldOfView, 1.0, 'fov restored');
    assert.strictEqual(a.player.invulnerable, false, 'invulnerability restored');
    server.run(0.2);
    assert.strictEqual(b.frame().draws, 0, 'remote drone removed');

    assert.deepStrictEqual(a.errors, [], 'no client errors');
    assert.deepStrictEqual(b.errors, [], 'no client errors');
});

test('crashing into the sea, reset, chase / los views', () => {
    const { server, a } = setup();
    // Stand above the sea on a cliff edge: pad radius is small, so flying off it
    // and cutting throttle drops the quad into the water.
    a.ui('fpv/ui/cmd', 'toggle');
    sticks(a, 0);
    a.ui('fpv/ui/cmd', 'arm');
    sticks(a, 0.8, 0, 0.5);
    server.run(1.5);
    a.ui('fpv/ui/cmd', 'arm');          // disarm in the air
    sticks(a, 0);
    server.run(8);
    const osd = JSON.parse(a.lastUi('fpv/osd')[0]);
    assert.strictEqual(osd.crashed, true);
    assert.strictEqual(osd.reason, 'WATER');

    a.ui('fpv/ui/cmd', 'reset');
    server.run(0.2);
    const after = JSON.parse(a.lastUi('fpv/osd')[0]);
    assert.strictEqual(after.crashed, false);
    assert.ok(Math.abs(after.alt) < 1, 'back on the pad');

    a.ui('fpv/ui/cmd', 'view');
    server.run(0.2);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).view, 'chase');
    a.ui('fpv/ui/cmd', 'view');
    server.run(0.2);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).view, 'los');
    assert.deepStrictEqual(a.errors, []);
});

test('arm switch on a transmitter needs a fresh flip to arm', () => {
    const { server, a } = setup();
    a.ui('fpv/ui/cmd', 'toggle');
    // Switch already ON when launching -> must not arm.
    a.hold(0, 0, 0, 0, 1, -0.9);
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, false);
    a.hold(0, 0, 0, 0, -1, -0.9);
    a.hold(0, 0, 0, 0, 1, -0.9);
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, true);
    // Mode switch high -> angle.
    a.hold(0, 0, 0, 0, 1, 1);
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).mode, 'angle');
    // A switch that sits at OFF does not fight the keyboard: E still toggles.
    a.hold(0, 0, 0, 0, -1, 1);
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, false, 'flipping the switch off disarms');
    a.ui('fpv/ui/cmd', 'arm');
    server.run(0.2);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, true, 'E arms with the switch left off');
});

test('server: follow only moves the character to the real drone position', () => {
    const { server, a } = setup();
    a.ui('fpv/ui/cmd', 'toggle');
    sticks(a, 0);
    server.run(0.5);
    const start = new Vector3f(a.player.position.x, a.player.position.y, a.player.position.z);
    server.fromClient(a.player, 'fpv/follow', [start.x + 5000, 1500, start.z, 0]);
    assert.strictEqual(a.player.position.x, start.x, 'teleport attempt ignored');
    // Garbage state packets are dropped instead of relayed.
    server.fromClient(a.player, 'fpv/swarm', ['[[0,NaN]]']);
    server.fromClient(a.player, 'fpv/swarm', ['{"x":1}']);
    server.fromClient(a.player, 'fpv/swarm', [12]);
    // Impacts far from any of the pilot's drones are ignored.
    const hp = a.server.players[1].health;
    a.server.players[1].position = new Vector3f(9000, 1050, 9000);
    server.fromClient(a.player, 'fpv/impact', [0, 9000, 1050, 9000, 40]);
    assert.strictEqual(a.server.players[1].health, hp, 'spoofed impact ignored');
    // Settings blob with junk does not break the client.
    a.ui('fpv/ui/settings', '{"tune":{"thrustToWeight":"lots"},"camera":{"eulerOrder":"QQQ","fovDeg":1e9}}');
    a.ui('fpv/ui/settings', 'not json');
    server.run(0.2);
    assert.deepStrictEqual(a.errors, []);
});

test('server denies launch from a vehicle and when disabled', () => {
    const { server, a } = setup();
    a.player.vehicle = {};
    a.ui('fpv/ui/cmd', 'toggle');
    assert.strictEqual(a.lp.camera.attachedToPlayer, true);
    assert.ok(/vehicle/.test(a.lastUi('fpv/notify')[0]));
    a.player.vehicle = null;
    server.config.enabled = false;
    server.run(5);   // let the pending request time out client-side
    a.ui('fpv/ui/cmd', 'toggle');
    assert.strictEqual(a.lp.camera.attachedToPlayer, true);
});

function osdOf(c) { return JSON.parse(c.lastUi('fpv/osd')[0]); }

function hover(server, a, alt) {
    a.ui('fpv/ui/settings', JSON.stringify({ mode: 'angle', altHold: true }));
    a.ui('fpv/ui/settings', JSON.stringify({ mode: 'angle', altHold: true }));
    a.ui('fpv/ui/cmd', 'toggle');
    sticks(a, 0.5);
    a.ui('fpv/ui/cmd', 'arm');
    sticks(a, 1);
    for (let i = 0; i < 100 && (!a.lastUi('fpv/osd') || osdOf(a).alt < alt); i++) { server.run(0.1); }
    sticks(a, 0.5);
    server.run(0.5);
}

test('swarm: call wingmen, they join, other players see the whole swarm', () => {
    const { server, a, b } = setup();
    hover(server, a, 40);
    a.ui('fpv/ui/cmd', 'call');
    a.ui('fpv/ui/cmd', 'call');
    server.run(12);
    const o = osdOf(a);
    assert.strictEqual(o.swarm.n, 2, 'two wingmen flying');
    assert.strictEqual(o.swarm.mode, 'formation');
    assert.ok(o.alt > 30, 'leader still hovering at ' + o.alt);
    const rb = b.frame();
    assert.ok(rb.draws >= 6, 'Bob draws 3 drones (2 quads each), draws=' + rb.draws);
    const ra = a.frame();
    assert.ok(ra.draws >= 4, 'Alice sees her wingmen, draws=' + ra.draws);
    assert.deepStrictEqual(a.errors, []);
    assert.deepStrictEqual(b.errors, []);
});

test('swarm: when the player crashes, control jumps to a wingman aimed at the crash', () => {
    const { server, a } = setup();
    hover(server, a, 40);
    a.ui('fpv/ui/cmd', 'call');
    a.ui('fpv/ui/cmd', 'call');
    server.run(12);
    assert.strictEqual(osdOf(a).swarm.id, 0);

    // Cut the motors: the quad drops into the sea below.
    a.ui('fpv/ui/settings', JSON.stringify({ mode: 'acro', altHold: false }));
    sticks(a, 0);
    let switched = false;
    for (let i = 0; i < 150 && !switched; i++) {
        server.run(0.1);
        const o = osdOf(a);
        switched = o.swarm.id !== 0 && !o.handover;
    }
    const o = osdOf(a);
    assert.ok(switched, 'control handed over: ' + JSON.stringify(o.swarm));
    assert.strictEqual(o.armed, true, 'new drone is armed');
    assert.strictEqual(o.crashed, false);
    assert.strictEqual(o.swarm.n, 1, 'one wingman left');
    assert.strictEqual(o.swarm.mode, 'support', 'remaining wingman circles the crash point');
    assert.ok(o.alt > 5, 'still in the air');

    // Switch command cycles to the remaining wingman.
    const before = o.swarm.id;
    a.ui('fpv/ui/cmd', 'switch');
    server.run(0.2);
    assert.notStrictEqual(osdOf(a).swarm.id, before);
    assert.deepStrictEqual(a.errors, []);
});

test('swarm attack: wingmen ram a nearby player and the server applies damage', () => {
    const { server, a, b } = setup();
    hover(server, a, 30);
    a.ui('fpv/ui/cmd', 'call');
    a.ui('fpv/ui/cmd', 'call');
    server.run(12);

    // Bob is standing 60 m away on a rooftop.
    const ap = a.lp.camera.position;
    b.player.position = new Vector3f(ap.x + 60, ap.y - 20, ap.z);
    const hp = b.player.health;
    a.ui('fpv/ui/cmd', 'attack');
    assert.ok(/attacking/.test(a.lastUi('fpv/notify')[0]), a.lastUi('fpv/notify')[0]);
    let flashes = 0;
    for (let i = 0; i < 100 && b.player.health === hp; i++) {
        const r = server.run(0.1);
        flashes += r[b.player.networkId].flashes;
    }
    assert.ok(b.player.health < hp, 'Bob took damage: ' + b.player.health);
    server.run(0.2);
    assert.strictEqual(osdOf(a).swarm.n, 0, 'kamikaze wingmen are spent');
    assert.ok(a.uiCalls.some((c) => c[0] === 'fpv/notify' && /attacking/.test(c[1])));
    assert.deepStrictEqual(a.errors, []);
    assert.deepStrictEqual(b.errors, []);
});

test('swarm attack with nothing in range reports it; full swarm refuses more calls', () => {
    const { server, a, b } = setup();
    b.player.position = new Vector3f(90000, 1050, 0);
    hover(server, a, 20);
    a.ui('fpv/ui/cmd', 'attack');
    assert.ok(/No wingmen/.test(a.lastUi('fpv/notify')[0]));
    for (let i = 0; i < 6; i++) { a.ui('fpv/ui/cmd', 'call'); }
    assert.ok(/Swarm full/.test(a.lastUi('fpv/notify')[0]));
    server.run(1);
    a.ui('fpv/ui/cmd', 'attack');
    assert.ok(/No targets/.test(a.lastUi('fpv/notify')[0]), a.lastUi('fpv/notify')[0]);
});

test('keyboard: hold W to take off, let go to hover, arrows fly forward', () => {
    const { server, a } = setup({ defaults: true });
    a.ui('fpv/ui/cmd', 'toggle');
    server.run(0.5);
    let o = osdOf(a);
    assert.strictEqual(o.mode, 'angle');
    assert.strictEqual(o.altHold, true);
    assert.strictEqual(o.armed, false);
    a.key(87, true);                      // W
    server.run(3);
    o = osdOf(a);
    assert.strictEqual(o.armed, true, 'W arms on the ground');
    assert.ok(o.alt > 5, 'climbing: ' + o.alt);
    a.key(87, false);
    server.run(1.5);
    const alt = osdOf(a).alt;
    server.run(2);
    assert.ok(Math.abs(osdOf(a).alt - alt) < 1.5, 'holds height');
    a.key(38, true);                      // Up arrow
    server.run(2);
    assert.ok(osdOf(a).speed > 20, 'moving forward: ' + osdOf(a).speed);
    a.key(38, false);
    assert.strictEqual(osdOf(a).src, 'keyboard');
    assert.deepStrictEqual(a.errors, []);
});

test('Rico stays where he launched and holds the radio; drone starts on the ground facing him', () => {
    const { server, a, b } = setup({ defaults: true });
    const start = { x: a.player.position.x, y: a.player.position.y, z: a.player.position.z };
    a.ui('fpv/ui/cmd', 'toggle');
    server.run(0.3);
    let o = osdOf(a);
    assert.ok(Math.abs(o.alt) < 0.3, 'on the ground: ' + o.alt);
    assert.ok(o.home > 1.5 && o.home < 4, 'a few steps from Rico: ' + o.home);
    assert.ok(Math.abs(Math.abs(o.homeDir) - 0) < 0.2, 'facing Rico (home straight ahead): ' + o.homeDir);

    const ra = a.frame();
    const radioTex = 'package://fpvdrone/textures/radio_face.png';
    assert.ok(ra.byTexture[radioTex] >= 1, 'local radio drawn');
    assert.ok(b.frame().byTexture[radioTex] >= 1, 'Bob sees the radio in Alice\'s hand');
    assert.strictEqual(ra.culling, false, 'culling off for double-sided faces');

    // Fly far away: the character must not be moved.
    a.key(87, true);
    server.run(3);
    a.key(87, false);
    a.key(38, true);
    server.run(15);
    a.key(38, false);
    assert.ok(osdOf(a).home > 200, 'flew ' + osdOf(a).home);
    assert.deepStrictEqual({ x: a.player.position.x, y: a.player.position.y, z: a.player.position.z }, start, 'Rico did not move');
    assert.strictEqual(a.lp.frozen, true);
});

test('the quad model is drawn with the textured 3D parts', () => {
    const { server, a, b } = setup();
    a.ui('fpv/ui/cmd', 'toggle');
    server.run(0.2);
    const rb = b.frame();
    const tex = (n) => rb.byTexture['package://fpvdrone/textures/' + n + '.png'] || 0;
    assert.ok(tex('carbon_top') >= 5 && tex('motor_side') >= 16 && tex('prop_still') === 4 && tex('cam_front') === 1,
        JSON.stringify(rb.byTexture));
});
