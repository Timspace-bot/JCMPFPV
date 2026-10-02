// ---------------------------------------------------------------------------
// client.js - glue between the simulation and JC3MP: camera, input from the
// UI, networking, remote drones and the OSD feed.
// ---------------------------------------------------------------------------

const STEP = 1 / 240;           // physics substep
const OSD_INTERVAL_MS = 33;
const MODES = ['acro', 'angle', 'horizon'];
const VIEWS = ['fpv', 'chase', 'los'];

// Server-provided config (see packages/fpvdrone/config.js). Defaults here are
// used until the server answers.
const cfg = {
    enabled: true,
    seaLevel: 1024,
    syncRateHz: 20,
    followDistance: 250,
    followDepth: 40,
    videoRange: 2500,
    maxAltitude: 4500,
    tuneOverrides: {}
};

// Local pilot settings (edited in the F8 panel, persisted by the UI).
const settings = {
    tune: FPV.cloneTune(FPV.DEFAULT_TUNE),
    camera: { eulerOrder: 'YXZ', pitchSign: -1, yawSign: -1, rollSign: -1, fovDeg: 92, modelRotSign: 1 },
    mode: 'acro',
    altHold: false,
    view: 'fpv'
};

let tune = FPV.cloneTune(FPV.DEFAULT_TUNE);

let status = 'idle';            // idle | pending | flying
let pendingSince = 0;
let drone = null;
let launch = null;              // {x,y,z} where the pilot is standing
let lastFollow = null;
let lastFrame = 0;
let acc = 0;
let lastSend = 0;
let lastOsd = 0;
let lastFollowCheck = 0;
let lastControlsAssert = 0;
let savedFov = null;
let chatOpen = false;
let menuOpen = false;
let prevCam = null;             // camera pose we set last frame (for lookAt validation)
let chaseYaw = 0;
let videoGlitchUntil = 0;
let armSwitchPrev = null;
let armBlockedReason = '';

const input = { throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: 'acro', altHold: false, source: 'keyboard' };

const world = new FPV.World(cfg.seaLevel);
const remotes = new FPV.Remotes();
const renderer = new FPV.RemoteRenderer();

const ui = new WebUIWindow('fpvdrone', 'package://fpvdrone/ui/index.html',
    new Vector2(jcmp.viewportSize.x, jcmp.viewportSize.y));
ui.autoResize = true;

function log(msg) {
    if (typeof jcmp.print === 'function') { jcmp.print('[fpvdrone] ' + msg); }
}

function notify(text, kind) {
    jcmp.ui.CallEvent('fpv/notify', text, kind || 'info');
}

function toVec3f(v) { return new Vector3f(v.x, v.y, v.z); }
function fromVec3f(v) { return { x: v.x, y: v.y, z: v.z }; }

function rebuildTune() {
    tune = FPV.cloneTune(settings.tune);
    FPV.mergeTune(tune, cfg.tuneOverrides);
}

// ---- start / stop ----------------------------------------------------------

function requestStart() {
    if (status !== 'idle') { return; }
    if (!cfg.enabled) { notify('FPV drones are disabled on this server', 'warn'); return; }
    status = 'pending';
    pendingSince = Date.now();
    jcmp.events.CallRemote('fpv/request_start');
}

function begin() {
    const lp = jcmp.localPlayer;
    launch = fromVec3f(lp.position);
    const heading = FPV.fromGameYaw(lp.camera.rotation.y, settings.camera);
    const fwd = FPV.qRotate(heading, { x: 0, y: 0, z: -1 });

    world.seaLevel = cfg.seaLevel;
    world.reset();
    world.addPad(launch.x, launch.y, launch.z, 4.0);

    rebuildTune();
    const start = FPV.add(launch, { x: fwd.x * 1.5, y: tune.collisionRadius, z: fwd.z * 1.5 });
    drone = FPV.createState(start, heading);
    drone.onGround = true;

    savedFov = lp.camera.fieldOfView;
    lp.frozen = true;
    lp.controlsEnabled = false;
    lp.camera.attachedToPlayer = false;
    lp.camera.fieldOfView = settings.camera.fovDeg * FPV.DEG;
    if (typeof jcmp.ui.HideHud === 'function') { jcmp.ui.HideHud(); }

    lastFollow = { x: launch.x, y: launch.y, z: launch.z };
    lastFrame = Date.now();
    acc = 0;
    prevCam = null;
    chaseYaw = FPV.yawOf(heading);
    armSwitchPrev = null;
    armBlockedReason = '';
    status = 'flying';
    jcmp.ui.CallEvent('fpv/active', true);
    notify('Drone ready - arm to take off (E or your arm switch)', 'info');
}

function end(tellServer) {
    if (status === 'pending') { status = 'idle'; return; }
    if (status !== 'flying') { return; }
    status = 'idle';
    const lp = jcmp.localPlayer;
    lp.camera.attachedToPlayer = true;
    if (savedFov !== null) { lp.camera.fieldOfView = savedFov; }
    lp.frozen = false;
    lp.controlsEnabled = !chatOpen && !menuOpen;
    if (typeof jcmp.ui.ShowHud === 'function') { jcmp.ui.ShowHud(); }
    drone = null;
    jcmp.ui.CallEvent('fpv/active', false);
    if (tellServer) { jcmp.events.CallRemote('fpv/stop'); }
}

function resetDrone() {
    if (!drone || !launch) { return; }
    const heading = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(drone.q));
    const fwd = FPV.qRotate(heading, { x: 0, y: 0, z: -1 });
    drone = FPV.createState(FPV.add(launch, { x: fwd.x * 1.5, y: tune.collisionRadius, z: fwd.z * 1.5 }), heading);
    drone.onGround = true;
    armSwitchPrev = null;
    jcmp.events.CallRemote('fpv/follow', launch.x, launch.y, launch.z, 1);
    lastFollow = { x: launch.x, y: launch.y, z: launch.z };
    notify('Drone reset to launch point', 'info');
}

// ---- arming / commands -----------------------------------------------------

function armRequest(on) {
    if (!drone) { return; }
    if (!on) { FPV.disarm(drone); return; }
    const reason = FPV.tryArm(drone, input);
    if (reason) {
        armBlockedReason = reason;
        notify(reason === 'THROTTLE' ? 'Arming blocked: lower the throttle' :
            reason === 'WATER' ? 'Drone is in the water - press R to reset' : 'Arming blocked: ' + reason, 'warn');
    } else {
        armBlockedReason = '';
    }
}

function command(name) {
    if (chatOpen) { return; }
    switch (name) {
        case 'toggle':
            if (status === 'flying') { end(true); } else { requestStart(); }
            break;
        case 'arm':
            if (drone) { armRequest(!drone.armed); }
            break;
        case 'reset':
            resetDrone();
            break;
        case 'mode':
            settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length];
            jcmp.ui.CallEvent('fpv/mode_changed', settings.mode, settings.altHold);
            break;
        case 'althold':
            settings.altHold = !settings.altHold;
            jcmp.ui.CallEvent('fpv/mode_changed', settings.mode, settings.altHold);
            break;
        case 'view':
            settings.view = VIEWS[(VIEWS.indexOf(settings.view) + 1) % VIEWS.length];
            jcmp.ui.CallEvent('fpv/view_changed', settings.view);
            break;
    }
}

// ---- camera ----------------------------------------------------------------

function lookRotation(dir) {
    const n = FPV.norm(dir);
    const yaw = Math.atan2(-n.x, -n.z);
    const pitch = Math.asin(FPV.clamp(n.y, -1, 1));
    return FPV.qMul(FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, yaw), FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, pitch));
}

function cameraFor(view, dt) {
    if (view === 'chase') {
        const target = FPV.yawOf(drone.q);
        chaseYaw += FPV.wrapAngle(target - chaseYaw) * (1 - Math.exp(-dt * 4));
        const h = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, chaseYaw);
        const back = FPV.qRotate(h, { x: 0, y: 0, z: 3.0 });
        const pos = FPV.add(drone.pos, { x: back.x, y: 1.0, z: back.z });
        return { pos: pos, q: lookRotation(FPV.sub(drone.pos, pos)) };
    }
    if (view === 'los') {
        const eye = FPV.add(launch, { x: 0, y: 1.7, z: 0 });
        const d = FPV.sub(drone.pos, eye);
        return { pos: eye, q: FPV.len(d) > 0.5 ? lookRotation(d) : FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(drone.q)) };
    }
    return FPV.cameraPose(drone, tune);
}

function applyCamera(cam) {
    const c = jcmp.localPlayer.camera;
    const e = FPV.toGameEuler(cam.q, settings.camera);
    c.position = toVec3f(cam.pos);
    c.rotation = new Vector3f(e.x, e.y, e.z);
}

// ---- per-frame -------------------------------------------------------------

function crashFeedback(ev) {
    videoGlitchUntil = Date.now() + 600;
    jcmp.events.CallRemote('fpv/crash', ev.reason);
}

function probeTerrain(dt) {
    if (!prevCam) { return; }
    let hit = null;
    try { hit = jcmp.localPlayer.lookAt; } catch (e) { hit = null; }
    if (!hit) { return; }
    const camFwd = FPV.qRotate(prevCam.q, { x: 0, y: 0, z: -1 });
    const dist = world.probe(prevCam.pos, camFwd, fromVec3f(hit));
    if (dist < 0 || settings.view !== 'fpv' || drone.crashed) { return; }

    // Head-on obstacle check along the camera ray.
    const along = FPV.dot(drone.vel, camFwd);
    const reach = tune.collisionRadius + 0.2 + Math.max(along, 0) * dt * 1.5;
    if (along > 1.5 && dist < reach) {
        const h = fromVec3f(hit);
        drone.pos = FPV.sub(h, FPV.scale(camFwd, tune.collisionRadius + 0.05));
        if (along > tune.crashSpeed) {
            FPV.crash(drone, 'IMPACT');
            drone.vel = FPV.scale(drone.vel, -0.1);
            // Looking down at what we hit -> it is ground, rest on it. A wall
            // hit lets the wreck drop to whatever floor is known below.
            if (camFwd.y < -0.5) { world.addPad(h.x, h.y, h.z, 1.5); }
        } else {
            // Gentle bump: bounce off, stay armed.
            drone.vel = FPV.sub(drone.vel, FPV.scale(camFwd, along * 1.4));
            drone.events.push({ type: 'bump' });
        }
    }
}

function sendState(now) {
    if (now - lastSend < 1000 / cfg.syncRateHz) { return; }
    lastSend = now;
    const p = drone.pos, q = drone.q;
    jcmp.events.CallRemote('fpv/state', p.x, p.y, p.z, q.x, q.y, q.z, q.w, drone.armed ? 1 : 0, drone.motor);
}

function followCheck(now) {
    // The world streams around the (frozen) character, so drag it along
    // underneath the drone when we get far away.
    if (now - lastFollowCheck < 1000) { return; }
    lastFollowCheck = now;
    const dx = drone.pos.x - lastFollow.x, dz = drone.pos.z - lastFollow.z;
    if (dx * dx + dz * dz > cfg.followDistance * cfg.followDistance) {
        jcmp.events.CallRemote('fpv/follow', drone.pos.x, drone.pos.y, drone.pos.z, 0);
        lastFollow = { x: drone.pos.x, y: drone.pos.y, z: drone.pos.z };
    }
}

function sendOsd(now) {
    if (now - lastOsd < OSD_INTERVAL_MS) { return; }
    lastOsd = now;
    const fwd = FPV.qRotate(drone.q, { x: 0, y: 0, z: -1 });
    const right = FPV.qRotate(drone.q, { x: 1, y: 0, z: 0 });
    const toHome = FPV.sub(launch, drone.pos);
    const distHome = Math.sqrt(toHome.x * toHome.x + toHome.z * toHome.z);
    const homeYaw = Math.atan2(-toHome.x, -toHome.z);
    const vr = cfg.videoRange;
    let noise = FPV.clamp((FPV.dist(launch, drone.pos) - vr * 0.75) / (vr * 0.25), 0, 1);
    if (now < videoGlitchUntil) { noise = Math.max(noise, (videoGlitchUntil - now) / 600); }
    jcmp.ui.CallEvent('fpv/osd', JSON.stringify({
        armed: drone.armed,
        crashed: drone.crashed,
        reason: drone.crashReason,
        blocked: armBlockedReason,
        mode: settings.mode,
        altHold: settings.altHold,
        view: settings.view,
        thr: input.throttle,
        motor: drone.motor,
        speed: FPV.len(drone.vel) * 3.6,
        vspeed: drone.vel.y,
        alt: drone.pos.y - launch.y,
        asl: drone.pos.y - cfg.seaLevel,
        home: distHome,
        homeDir: FPV.wrapAngle(homeYaw - FPV.yawOf(drone.q)),
        pitch: Math.asin(FPV.clamp(fwd.y, -1, 1)),
        roll: Math.asin(FPV.clamp(-right.y, -1, 1)),
        tilt: tune.cameraTiltDeg,
        cell: drone.cellVoltage,
        cells: tune.battery.cells,
        mah: drone.usedMah,
        cap: tune.battery.capacityMah,
        batt: tune.battery.enabled,
        amps: drone.currentA,
        time: drone.flightTime,
        noise: noise,
        probe: world.probeValid,
        src: input.source
    }));
}

function frame(r) {
    const now = Date.now();

    if (status === 'pending' && now - pendingSince > 4000) {
        status = 'idle';
        notify('Server did not answer the FPV request', 'warn');
    }

    remotes.update(now);
    const camPos = fromVec3f(jcmp.localPlayer.camera.position);
    renderer.draw3d(r, remotes, camPos, settings.camera.modelRotSign);

    if (status !== 'flying' || !drone) { return; }

    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!(dt > 0)) { dt = 0; }
    if (dt > 0.1) { dt = 0.1; }   // hitch / alt-tab: don't explode

    input.mode = settings.mode;
    input.altHold = settings.altHold;

    acc += dt;
    while (acc >= STEP) {
        FPV.step(drone, input, world, tune, STEP);
        acc -= STEP;
    }
    if (drone.pos.y > cfg.maxAltitude) { drone.pos.y = cfg.maxAltitude; if (drone.vel.y > 0) { drone.vel.y = 0; } }

    probeTerrain(dt);

    while (drone.events.length) {
        const ev = drone.events.shift();
        if (ev.type === 'crash') { crashFeedback(ev); }
    }

    const cam = cameraFor(settings.view, dt);
    applyCamera(cam);
    prevCam = cam;

    if (now - lastControlsAssert > 500) {
        lastControlsAssert = now;
        jcmp.localPlayer.controlsEnabled = false;
    }

    sendState(now);
    followCheck(now);
    sendOsd(now);
}

// ---- events: game ----------------------------------------------------------

jcmp.events.Add('GameUpdateRender', (r) => {
    try { frame(r); } catch (e) { log('frame error: ' + (e && e.stack ? e.stack : e)); }
});

jcmp.events.Add('Render', (r) => {
    try {
        renderer.draw2d(r, remotes, fromVec3f(jcmp.localPlayer.camera.position));
    } catch (e) { log('render error: ' + e); }
});

// ---- events: UI ------------------------------------------------------------

jcmp.ui.AddEvent('fpv/ui/ready', () => {
    jcmp.events.CallRemote('fpv/ready');
});

jcmp.ui.AddEvent('fpv/ui/cmd', (name) => { command(name); });

jcmp.ui.AddEvent('fpv/ui/menu', (open) => {
    menuOpen = !!open;
    if (status !== 'flying') { jcmp.localPlayer.controlsEnabled = !menuOpen && !chatOpen; }
});

// Sticks arrive already mapped/calibrated by the UI (gamepad or keyboard).
// arm/mode are -2 when the pilot has not mapped a switch.
jcmp.ui.AddEvent('fpv/ui/sticks', (t, roll, pitch, yaw, arm, mode, source) => {
    input.throttle = FPV.clamp(+t || 0, 0, 1);
    input.roll = FPV.clamp(+roll || 0, -1, 1);
    input.pitch = FPV.clamp(+pitch || 0, -1, 1);
    input.yaw = FPV.clamp(+yaw || 0, -1, 1);
    input.source = source;
    if (!drone || chatOpen) { return; }

    if (arm > -1.5) {
        const on = arm > 0.5;
        if (armSwitchPrev !== null && on !== armSwitchPrev) { armRequest(on); }
        armSwitchPrev = on;
        if (!on && drone.armed) { FPV.disarm(drone); }
    }
    if (mode > -1.5) {
        const m = mode < -0.33 ? 'acro' : (mode > 0.33 ? 'angle' : 'horizon');
        if (m !== settings.mode) {
            settings.mode = m;
            jcmp.ui.CallEvent('fpv/mode_changed', settings.mode, settings.altHold);
        }
    }
});

jcmp.ui.AddEvent('fpv/ui/settings', (json) => {
    let s;
    try { s = JSON.parse(json); } catch (e) { return; }
    if (!s || typeof s !== 'object') { return; }
    if (s.tune) { FPV.mergeTune(settings.tune, s.tune); }
    if (s.camera) {
        const c = settings.camera;
        if (['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'].indexOf(s.camera.eulerOrder) >= 0) { c.eulerOrder = s.camera.eulerOrder; }
        ['pitchSign', 'yawSign', 'rollSign', 'modelRotSign'].forEach((k) => {
            if (s.camera[k] === 1 || s.camera[k] === -1) { c[k] = s.camera[k]; }
        });
        if (isFinite(s.camera.fovDeg)) { c.fovDeg = FPV.clamp(+s.camera.fovDeg, 40, 150); }
    }
    if (MODES.indexOf(s.mode) >= 0) { settings.mode = s.mode; }
    if (typeof s.altHold === 'boolean') { settings.altHold = s.altHold; }
    if (VIEWS.indexOf(s.view) >= 0) { settings.view = s.view; }
    rebuildTune();
    if (status === 'flying') { jcmp.localPlayer.camera.fieldOfView = settings.camera.fovDeg * FPV.DEG; }
});

// Other packages' chat (chat / chat2) broadcast this while the input box is open.
jcmp.ui.AddEvent('chat_input_state', (s) => {
    chatOpen = !!s;
    jcmp.ui.CallEvent('fpv/chat', chatOpen);
});

// ---- events: server --------------------------------------------------------

jcmp.events.AddRemoteCallable('fpv/config', (json) => {
    try {
        const c = JSON.parse(json);
        for (const k in cfg) {
            if (Object.prototype.hasOwnProperty.call(c, k) && typeof c[k] === typeof cfg[k]) { cfg[k] = c[k]; }
        }
        world.seaLevel = cfg.seaLevel;
        rebuildTune();
        jcmp.ui.CallEvent('fpv/config', JSON.stringify(cfg));
    } catch (e) { log('bad config: ' + e); }
});

jcmp.events.AddRemoteCallable('fpv/toggle', () => {
    if (status === 'flying') { end(true); } else { requestStart(); }
});

jcmp.events.AddRemoteCallable('fpv/start', () => {
    if (status === 'pending') { begin(); }
});

jcmp.events.AddRemoteCallable('fpv/denied', (reason) => {
    if (status === 'pending') { status = 'idle'; }
    notify(reason, 'warn');
});

jcmp.events.AddRemoteCallable('fpv/force_stop', (reason) => {
    end(false);
    if (reason) { notify(reason, 'warn'); }
});

jcmp.events.AddRemoteCallable('fpv/remote_start', (id, name) => {
    if (id === jcmp.localPlayer.networkId) { return; }
    remotes.ensure(id, name).last = Date.now();
});

jcmp.events.AddRemoteCallable('fpv/remote_stop', (id) => { remotes.remove(id); });

jcmp.events.AddRemoteCallable('fpv/remote_state', (id, x, y, z, qx, qy, qz, qw, armed, motor) => {
    if (id === jcmp.localPlayer.networkId) { return; }
    remotes.push(id, Date.now(), { x: x, y: y, z: z }, { x: qx, y: qy, z: qz, w: qw }, !!armed, motor);
});

jcmp.events.AddRemoteCallable('fpv/remote_crash', (name, reason) => {
    jcmp.ui.CallEvent('fpv/feed', name + (reason === 'WATER' ? ' ditched in the sea' : ' crashed'));
});
