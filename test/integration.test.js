'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../tools/build.js').build();
const { Server, Vector3f } = require('./harness');

function setup() {
    const server = new Server();
    const a = server.connect('Alice');
    const b = server.connect('Bob');
    a.ui('fpv/ui/ready');
    b.ui('fpv/ui/ready');
    return { server, a, b };
}

function sticks(c, t, roll, pitch, yaw) {
    c.ui('fpv/ui/sticks', t, roll || 0, pitch || 0, yaw || 0, -2, -2, 'keyboard');
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
    a.ui('fpv/ui/sticks', 0, 0, 0, 0, 1, -0.9, 'gamepad');
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, false);
    a.ui('fpv/ui/sticks', 0, 0, 0, 0, -1, -0.9, 'gamepad');
    a.ui('fpv/ui/sticks', 0, 0, 0, 0, 1, -0.9, 'gamepad');
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).armed, true);
    // Mode switch high -> angle.
    a.ui('fpv/ui/sticks', 0, 0, 0, 0, 1, 1, 'gamepad');
    server.run(0.1);
    assert.strictEqual(JSON.parse(a.lastUi('fpv/osd')[0]).mode, 'angle');
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
    server.fromClient(a.player, 'fpv/state', [NaN, 0, 0, 0, 0, 0, 1, 1, 0]);
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
