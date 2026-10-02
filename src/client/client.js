// ---------------------------------------------------------------------------
// client.js - glue between the simulation and JC3MP: camera, input from the
// UI, the swarm, networking, remote drones and the OSD feed.
// ---------------------------------------------------------------------------

const STEP = 1 / 240;           // physics substep
const OSD_INTERVAL_MS = 33;
const HANDOVER_MAX_MS = 900;    // longest the auto-aim may take before control passes
const MODES = ['acro', 'angle', 'horizon'];
const VIEWS = ['fpv', 'chase', 'los'];

// Server-provided config (see packages/fpvdrone/config.js). Defaults here are
// used until the server answers.
const cfg = {
    enabled: true,
    seaLevel: 1024,
    syncRateHz: 20,
    followDistance: 0,
    followDepth: 40,
    videoRange: 2500,
    maxAltitude: 4500,
    tuneOverrides: {},
    swarm: { enabled: true },
    damage: { enabled: true, minSpeed: 10 }
};

// Local pilot settings (edited in the F8 panel, persisted by the UI).
const settings = {
    tune: FPV.cloneTune(FPV.DEFAULT_TUNE),
    camera: { eulerOrder: 'YXZ', pitchSign: -1, yawSign: -1, rollSign: -1, fovDeg: 92, modelRotSign: 1 },
    mode: 'angle',
    altHold: true,
    view: 'fpv',
    kbStrength: 0.6
};

let tune = FPV.cloneTune(FPV.DEFAULT_TUNE);

let status = 'idle';            // idle | pending | flying
let pendingSince = 0;
let drone = null;               // the drone the player is flying
let droneId = 0;                // its id within our swarm (ids are sent over the network)
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
let handover = null;            // {w, t0, point} while a wingman auto-aims before we take it
let banner = null;              // {text, until} short OSD banner
const effects = [];             // impact flashes [{pos, t0}]
const targetTracks = {};        // key -> {pos, t} for velocity estimates

const input = { throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: 'angle', altHold: true, source: 'keyboard' };

// Keyboard flying is integrated here, per game frame, from raw key events the
// UI forwards (UI timers can be throttled by CEF; key events are not).
const KEY = { W: 87, S: 83, A: 65, D: 68, X: 88, SHIFT: 16, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
const keys = {};
const kb = { t: 0, r: 0, p: 0, y: 0 };
let padSticks = null;           // latest controller sticks from the UI
let padAt = 0;                  // when they arrived
let fps = 0;

// Bones (see types-jcmp LocalPlayer.GetBoneTransform).
const BONE_RIGHT_HAND_ATTACH = 0x65C5D2EB;
const BONE_LEFT_FOOT = 0x661134AC;
const BONE_RIGHT_FOOT = 0xFF3E004B;
const ANKLE_HEIGHT = 0.07;

const world = new FPV.World(cfg.seaLevel);
const remotes = new FPV.Remotes();
const renderer = new FPV.RemoteRenderer();
const models = new FPV.ModelRenderer();
let swarm = new FPV.Swarm({}, tune);

const ui = new WebUIWindow('fpvdrone', 'package://fpvdrone/ui/index.html',
    new Vector2(jcmp.viewportSize.x, jcmp.viewportSize.y));
ui.autoResize = true;

const COLOR_WING = new RGBA(90, 220, 255, 230);
const COLOR_ATTACK = new RGBA(255, 90, 70, 240);
const COLOR_WRECK = new RGBA(150, 150, 150, 200);
const COLOR_ARMED = new RGBA(80, 255, 120, 230);
const COLOR_NAME = new RGBA(255, 255, 255, 230);

function log(msg) {
    if (typeof jcmp.print === 'function') { jcmp.print('[fpvdrone] ' + msg); }
}

function notify(text, kind) {
    jcmp.ui.CallEvent('fpv/notify', text, kind || 'info');
}

function showBanner(text, ms) {
    banner = { text: text, until: Date.now() + (ms || 1500) };
}

function toVec3f(v) { return new Vector3f(v.x, v.y, v.z); }
function fromVec3f(v) { return { x: v.x, y: v.y, z: v.z }; }

function rebuildTune() {
    tune = FPV.cloneTune(settings.tune);
    FPV.mergeTune(tune, cfg.tuneOverrides);
    swarm.setTune(tune);
    swarm.configure(cfg.swarm);
    swarm.opts.impactMinSpeed = cfg.damage.minSpeed;
}

function swarmEnabled() { return cfg.swarm.enabled !== false; }

// ---- ground truth from characters --------------------------------------------

function boneY(player, bone, dtf) {
    try {
        const m = player.GetBoneTransform(bone, dtf || 0);
        const p = m && m.position;
        return p && isFinite(p.y) ? p.y : null;
    } catch (e) { return null; }
}

// Ground height under Rico from his foot bones (falls back to his position).
function groundUnderLocalPlayer(dtf) {
    const lp = jcmp.localPlayer;
    if (typeof lp.GetBoneTransform !== 'function') { return null; }
    const l = boneY(lp, BONE_LEFT_FOOT, dtf), r = boneY(lp, BONE_RIGHT_FOOT, dtf);
    if (l === null && r === null) { return null; }
    const foot = Math.min(l === null ? Infinity : l, r === null ? Infinity : r) - ANKLE_HEIGHT;
    // Only trust it if the feet are near the character root (standing, not
    // swinging from the grapple or skydiving).
    return Math.abs(foot - lp.position.y) < 0.6 ? Math.min(foot, lp.position.y + 0.05) : null;
}

// While on foot (and for other players), every place a character stands is a
// known piece of ground the drone can land on later.
const footTracks = {};
let lastFootprint = 0;
function recordFootprints(now) {
    if (now - lastFootprint < 300) { return; }
    lastFootprint = now;
    function track(key, pos) {
        const prev = footTracks[key];
        footTracks[key] = { pos: pos, t: now };
        if (prev && now - prev.t < 1000 && Math.abs(prev.pos.y - pos.y) < 0.08 &&
            FPV.dist(prev.pos, pos) < 8) {
            world.addGround(pos.x, pos.y, pos.z);
        }
    }
    if (status !== 'flying') {
        const g = groundUnderLocalPlayer();
        if (g !== null) {
            const p = jcmp.localPlayer.position;
            track('me', { x: p.x, y: g, z: p.z });
        }
    }
    if (jcmp.players) {
        for (let i = 0; i < jcmp.players.length; i++) {
            const p = jcmp.players[i];
            if (!p || p.networkId === jcmp.localPlayer.networkId || remotes.pilots[p.networkId] !== undefined) { continue; }
            const pp = p.position;
            if (pp) { track('p' + p.networkId, { x: pp.x, y: pp.y, z: pp.z }); }
        }
    }
}

// The radio in Rico's hands (ours, and every other pilot's).
function drawRadios(r) {
    if (status === 'flying' && typeof jcmp.localPlayer.GetBoneTransform === 'function') {
        models.drawRadio(r, function () { return jcmp.localPlayer.GetBoneTransform(BONE_RIGHT_HAND_ATTACH, r.dtf || 0); });
    }
    if (!jcmp.players) { return; }
    for (let i = 0; i < jcmp.players.length; i++) {
        const p = jcmp.players[i];
        if (!p || remotes.pilots[p.networkId] === undefined || typeof p.GetBoneTransform !== 'function') { continue; }
        models.drawRadio(r, function () { return p.GetBoneTransform(BONE_RIGHT_HAND_ATTACH, r.dtf || 0); });
    }
}

// ---- keyboard sticks --------------------------------------------------------

function keyboardActive() {
    return keys[KEY.W] || keys[KEY.S] || keys[KEY.A] || keys[KEY.D] || keys[KEY.X] ||
        keys[KEY.LEFT] || keys[KEY.RIGHT] || keys[KEY.UP] || keys[KEY.DOWN];
}

function updateKeyboardSticks(dt) {
    const k = settings.kbStrength;
    const on = function (c) { return keys[c] && !chatOpen ? 1 : 0; };
    const a = Math.min(1, dt * 12);
    kb.r += ((on(KEY.RIGHT) - on(KEY.LEFT)) * k - kb.r) * a;
    kb.p += ((on(KEY.UP) - on(KEY.DOWN)) * k - kb.p) * a;
    kb.y += ((on(KEY.D) - on(KEY.A)) * k - kb.y) * a;
    if (settings.altHold && settings.mode !== 'acro') {
        // Centre = hover; W climbs, S descends, Shift+W climbs at full rate.
        const tt = on(KEY.W) ? (on(KEY.SHIFT) ? 1 : 0.85) : (on(KEY.S) ? 0.1 : 0.5);
        kb.t += (tt - kb.t) * Math.min(1, dt * 8);
    } else {
        if (on(KEY.W)) { kb.t += (on(KEY.SHIFT) ? 2.0 : 0.9) * dt; }
        if (on(KEY.S)) { kb.t -= 1.2 * dt; }
        if (on(KEY.X)) { kb.t = 0; }
        kb.t = FPV.clamp(kb.t, 0, 1);
    }
}

// Pick the live input: a controller that is sending, unless flight keys are held.
function resolveInput(now, dt) {
    updateKeyboardSticks(dt);
    const padLive = padSticks && now - padAt < 400;
    if (padLive && !keyboardActive()) {
        input.throttle = padSticks.t; input.roll = padSticks.r; input.pitch = padSticks.p; input.yaw = padSticks.y;
        input.source = 'gamepad';
    } else {
        input.throttle = kb.t; input.roll = kb.r; input.pitch = kb.p; input.yaw = kb.y;
        input.source = 'keyboard';
        // Keyboard pilots: throttling up on the ground arms the quad.
        if (keys[KEY.W] && drone && !drone.armed && !drone.inWater && !handover && drone.onGround) {
            const t = input.throttle;
            input.throttle = 0;   // the key press is the arm gesture, not a throttle-up
            armRequest(true);
            input.throttle = t;
        }
    }
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
    // Rico stays where he is; the quad sits on the ground a few steps in front
    // of him, turned round to face him.
    launch = fromVec3f(lp.position);
    const ground = groundUnderLocalPlayer();
    if (ground !== null) { launch.y = ground; }
    const look = FPV.fromGameYaw(lp.camera.rotation.y, settings.camera);
    const fwd = FPV.qRotate(look, { x: 0, y: 0, z: -1 });
    const heading = FPV.qMul(look, FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI));

    world.seaLevel = cfg.seaLevel;
    world.reset();
    world.addPad(launch.x, launch.y, launch.z, 8.0);
    world.addGround(launch.x, launch.y, launch.z);

    swarm = new FPV.Swarm({}, tune);
    rebuildTune();
    const start = FPV.add(launch, { x: fwd.x * 2.5, y: tune.collisionRadius, z: fwd.z * 2.5 });
    drone = FPV.createState(start, heading);
    drone.onGround = true;
    droneId = 0;
    handover = null;

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
    kb.t = settings.altHold && settings.mode !== 'acro' ? 0.5 : 0;
    for (const k in keys) { keys[k] = false; }
    status = 'flying';
    jcmp.ui.CallEvent('fpv/active', true);
    notify('Drone ready - hold W to take off (or arm with E / your arm switch)', 'info');
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
    handover = null;
    swarm = new FPV.Swarm({}, tune);
    jcmp.ui.CallEvent('fpv/active', false);
    if (tellServer) { jcmp.events.CallRemote('fpv/stop'); }
}

function resetDrone() {
    if (!drone || !launch) { return; }
    if (handover) { finishHandover(); }
    const heading = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(drone.q));
    const fwd = FPV.qRotate(heading, { x: 0, y: 0, z: -1 });
    drone = FPV.createState(FPV.add(launch, { x: fwd.x * 1.5, y: tune.collisionRadius, z: fwd.z * 1.5 }), heading);
    drone.onGround = true;
    armSwitchPrev = null;
    if (cfg.followDistance) { jcmp.events.CallRemote('fpv/follow', launch.x, launch.y, launch.z, 1); }
    lastFollow = { x: launch.x, y: launch.y, z: launch.z };
    notify('Drone reset to launch point', 'info');
}

// ---- arming / commands -----------------------------------------------------

function armRequest(on) {
    if (!drone || handover) { return; }
    if (!on) { FPV.disarm(drone); return; }
    input.mode = settings.mode;
    input.altHold = settings.altHold;
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
        case 'call':
            callWingman();
            break;
        case 'attack':
            swarmAttack();
            break;
        case 'switch':
            switchDrone();
            break;
    }
}

// ---- swarm -----------------------------------------------------------------

// Launch a wingman. Near home it lifts off from the launch pad; far away it
// arrives from behind and above (as if dispatched from a nearby truck).
function callWingman() {
    if (!drone || status !== 'flying') { return; }
    if (!swarmEnabled()) { notify('Swarm is disabled on this server', 'warn'); return; }
    const n = swarm.flying().length;
    let pos;
    if (FPV.dist(launch, drone.pos) < 600) {
        const a = n * 1.3;
        pos = { x: launch.x + Math.cos(a) * 3, y: launch.y + tune.collisionRadius, z: launch.z + Math.sin(a) * 3 };
    } else {
        const back = FPV.qRotate(FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(drone.q)), { x: 0, y: 0, z: 150 });
        pos = FPV.add(drone.pos, { x: back.x, y: 30, z: back.z });
    }
    const w = swarm.spawn(pos, FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(drone.q)));
    if (!w) { notify('Swarm full (' + swarm.opts.maxWingmen + ' wingmen)', 'warn'); return; }
    if (pos.y > launch.y + 5) { w.s.onGround = false; }
    notify('Wingman W' + w.id + ' inbound', 'info');
}

function gatherTargets() {
    const now = Date.now();
    const out = {};
    function add(key, p) {
        const pos = { x: p.x, y: p.y, z: p.z };
        if (!FPV.isFiniteVec(pos)) { return; }
        const prev = targetTracks[key];
        let vel = { x: 0, y: 0, z: 0 };
        if (prev && now - prev.t > 0 && now - prev.t < 1000) {
            vel = FPV.scale(FPV.sub(pos, prev.pos), 1000 / (now - prev.t));
            if (FPV.len(vel) > 150) { vel = { x: 0, y: 0, z: 0 }; }
        }
        if (!prev || now - prev.t > 50) { targetTracks[key] = { pos: pos, t: now }; }
        out[key] = { key: key, pos: pos, vel: vel };
    }
    const me = jcmp.localPlayer.networkId;
    if (jcmp.players) {
        for (let i = 0; i < jcmp.players.length; i++) {
            const p = jcmp.players[i];
            if (!p || p.networkId === me || remotes.pilots[p.networkId] !== undefined) { continue; }
            if (typeof p.health === 'number' && p.health <= 0) { continue; }
            // Aim at the chest rather than the feet.
            const pp = p.position;
            if (pp) { add('p' + p.networkId, { x: pp.x, y: pp.y + 1.0, z: pp.z }); }
        }
    }
    if (jcmp.vehicles) {
        for (let i = 0; i < jcmp.vehicles.length; i++) {
            const v = jcmp.vehicles[i];
            if (v && v.position) { add('v' + (v.networkId !== undefined ? v.networkId : i), { x: v.position.x, y: v.position.y + 0.8, z: v.position.z }); }
        }
    }
    for (const k in remotes.list) {
        const r = remotes.list[k];
        if (r.pose && !(r.flags & FPV.FLAG_CRASHED)) { add('d' + k, r.pose.pos); }
    }
    return out;
}

function swarmAttack() {
    if (!drone || !swarmEnabled()) { return; }
    if (swarm.attackers().length) {
        swarm.recall();
        notify('Swarm attack called off', 'info');
        return;
    }
    if (!swarm.flying().length) { notify('No wingmen - call one first', 'warn'); return; }
    const targets = gatherTargets();
    const list = Object.keys(targets).map(function (k) { return targets[k]; });
    const n = swarm.attack(list, drone.pos);
    if (!n) { notify('No targets within ' + swarm.opts.attackRadius + 'm', 'warn'); return; }
    showBanner('SWARM ATTACK x' + n, 1500);
    notify(n + ' wingm' + (n === 1 ? 'an' : 'en') + ' attacking', 'warn');
}

// Hand control to wingman `w`. The old drone rejoins as a wingman if it can
// still fly, otherwise it is left as a wreck.
function takeControl(w) {
    swarm.remove(w);
    if (drone.crashed || drone.inWater) { swarm.wreck(drone, droneId); }
    else { swarm.add(drone, 'join', droneId); }
    drone = w.s;
    droneId = w.id;
    drone.events = [];
    drone.armed = true;
    drone.crashed = false;
    armBlockedReason = '';
    videoGlitchUntil = Date.now() + 350;
    lastFollow = { x: drone.pos.x - 1e6, y: 0, z: 0 };   // force a follow update
    showBanner('LINK > W' + w.id, 1200);
}

function switchDrone() {
    if (!drone || handover) { return; }
    const flying = swarm.wingmen.filter(function (w) { return w.role !== 'wreck' && w.role !== 'aim' && !w.s.crashed; })
        .sort(function (a, b) { return a.id - b.id; });
    if (!flying.length) { notify('No other drone to switch to', 'warn'); return; }
    const next = flying.find(function (w) { return w.id > droneId; }) || flying[0];
    takeControl(next);
}

// Our drone just crashed: circle the impact point and hand control to the
// wingman best placed to see it, after it has pointed its camera there.
function startHandover(point) {
    if (!swarmEnabled()) { return; }
    swarm.focus(point);
    const w = swarm.pickHandover(point);
    if (!w) { return; }
    w.role = 'aim';
    w.aimPoint = { x: point.x, y: point.y, z: point.z };
    handover = { w: w, t0: Date.now(), point: w.aimPoint };
    showBanner('LINK > W' + w.id + '  AUTO-AIM', HANDOVER_MAX_MS + 600);
}

function finishHandover() {
    const h = handover;
    handover = null;
    if (!h || h.w.s.crashed || swarm.wingmen.indexOf(h.w) < 0) { return; }
    takeControl(h.w);
}

function sendImpact(id, pos, speed) {
    if (!cfg.damage.enabled || speed < cfg.damage.minSpeed) { return; }
    jcmp.events.CallRemote('fpv/impact', id, pos.x, pos.y, pos.z, speed);
}

// ---- camera ----------------------------------------------------------------

function cameraFor(view, dt) {
    const s = handover ? handover.w.s : drone;
    if (view === 'chase') {
        const target = FPV.yawOf(s.q);
        chaseYaw += FPV.wrapAngle(target - chaseYaw) * (1 - Math.exp(-dt * 4));
        const h = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, chaseYaw);
        const back = FPV.qRotate(h, { x: 0, y: 0, z: 3.0 });
        const pos = FPV.add(s.pos, { x: back.x, y: 1.0, z: back.z });
        return { pos: pos, q: FPV.lookRotation(FPV.sub(s.pos, pos)) };
    }
    if (view === 'los') {
        const eye = FPV.add(launch, { x: 0, y: 1.7, z: 0 });
        const d = FPV.sub(s.pos, eye);
        return { pos: eye, q: FPV.len(d) > 0.5 ? FPV.lookRotation(d) : FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, FPV.yawOf(s.q)) };
    }
    return FPV.cameraPose(s, tune);
}

function applyCamera(cam) {
    const c = jcmp.localPlayer.camera;
    const e = FPV.toGameEuler(cam.q, settings.camera);
    c.position = toVec3f(cam.pos);
    c.rotation = new Vector3f(e.x, e.y, e.z);
}

// ---- per-frame -------------------------------------------------------------

function onOwnCrash(ev) {
    videoGlitchUntil = Date.now() + 600;
    jcmp.events.CallRemote('fpv/crash', ev.reason);
    if (ev.reason !== 'WATER' && ev.reason !== 'HIT') { sendImpact(droneId, drone.pos, ev.speed); }
    startHandover(drone.pos);
}

function probeTerrain(dt) {
    if (!prevCam) { return; }
    let hit = null;
    try { hit = jcmp.localPlayer.lookAt; } catch (e) { hit = null; }
    if (!hit) { return; }
    const camFwd = FPV.qRotate(prevCam.q, { x: 0, y: 0, z: -1 });
    const dist = world.probe(prevCam.pos, camFwd, fromVec3f(hit));
    if (dist < 0 || settings.view !== 'fpv' || drone.crashed || handover) { return; }

    // Head-on obstacle check along the camera ray.
    const along = FPV.dot(drone.vel, camFwd);
    const reach = tune.collisionRadius + 0.2 + Math.max(along, 0) * dt * 1.5;
    if (along > 1.5 && dist < reach) {
        const h = fromVec3f(hit);
        drone.pos = FPV.sub(h, FPV.scale(camFwd, tune.collisionRadius + 0.05));
        if (along > tune.crashSpeed) {
            // Report the crash at the surface we hit (the attack point).
            FPV.crash(drone, 'IMPACT');
            const ev = drone.events[drone.events.length - 1];
            ev.speed = along;
            drone.pos = h;
            drone.vel = FPV.scale(drone.vel, -0.1);
            // Looking down at what we hit -> it is ground, rest on it. A wall
            // hit lets the wreck drop to whatever floor is known below.
            if (camFwd.y < -0.5) { world.addPad(h.x, h.y, h.z, 1.5); }
        } else {
            // Gentle bump: bounce off, stay armed.
            drone.vel = FPV.sub(drone.vel, FPV.scale(camFwd, along * 1.4));
        }
    }
}

function packDrone(id, s, flags) {
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    const r4 = function (v) { return Math.round(v * 10000) / 10000; };
    return [id, r2(s.pos.x), r2(s.pos.y), r2(s.pos.z), r4(s.q.x), r4(s.q.y), r4(s.q.z), r4(s.q.w), flags];
}

function sendState(now) {
    if (now - lastSend < 1000 / cfg.syncRateHz) { return; }
    lastSend = now;
    const list = [packDrone(droneId, drone, FPV.FLAG_CONTROLLED |
        (drone.armed ? FPV.FLAG_ARMED : 0) | (drone.crashed ? FPV.FLAG_CRASHED : 0))];
    swarm.wingmen.forEach(function (w) {
        list.push(packDrone(w.id, w.s, (w.s.armed ? FPV.FLAG_ARMED : 0) | (w.s.crashed ? FPV.FLAG_CRASHED : 0)));
    });
    jcmp.events.CallRemote('fpv/swarm', JSON.stringify(list));
}

function followCheck(now) {
    // The world streams around the (frozen) character, so drag it along
    // underneath the drone when we get far away.
    if (now - lastFollowCheck < 1000 || !cfg.followDistance) { return; }
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
    const s = handover ? handover.w.s : drone;
    const fwd = FPV.qRotate(s.q, { x: 0, y: 0, z: -1 });
    const right = FPV.qRotate(s.q, { x: 1, y: 0, z: 0 });
    const toHome = FPV.sub(launch, s.pos);
    const distHome = Math.sqrt(toHome.x * toHome.x + toHome.z * toHome.z);
    const homeYaw = Math.atan2(-toHome.x, -toHome.z);
    const vr = cfg.videoRange;
    let noise = FPV.clamp((FPV.dist(launch, s.pos) - vr * 0.75) / (vr * 0.25), 0, 1);
    if (now < videoGlitchUntil) { noise = Math.max(noise, (videoGlitchUntil - now) / 600); }
    jcmp.ui.CallEvent('fpv/osd', JSON.stringify({
        armed: s.armed,
        crashed: s.crashed,
        reason: s.crashReason,
        blocked: armBlockedReason,
        mode: settings.mode,
        altHold: settings.altHold,
        view: settings.view,
        thr: input.throttle,
        motor: s.motor,
        speed: FPV.len(s.vel) * 3.6,
        vspeed: s.vel.y,
        alt: s.pos.y - launch.y,
        asl: s.pos.y - cfg.seaLevel,
        home: distHome,
        homeDir: FPV.wrapAngle(homeYaw - FPV.yawOf(s.q)),
        pitch: Math.asin(FPV.clamp(fwd.y, -1, 1)),
        roll: Math.asin(FPV.clamp(-right.y, -1, 1)),
        tilt: tune.cameraTiltDeg,
        cell: drone.cellVoltage,
        cells: tune.battery.cells,
        mah: drone.usedMah,
        cap: tune.battery.capacityMah,
        batt: tune.battery.enabled && !handover,
        amps: drone.currentA,
        time: drone.flightTime,
        noise: noise,
        probe: world.probeValid,
        fps: Math.round(fps),
        sticks: { t: input.throttle, r: input.roll, p: input.pitch, y: input.yaw },
        dbg: {
            probeOk: world.validSamples,
            probeTries: world.probeTries,
            samples: world.sampleCount(),
            floor: Math.round((world.floorAt(s.pos).y - launch.y) * 10) / 10,
            floorSrc: world.lastSrc,
            pad: !!(padSticks && now - padAt < 400)
        },
        src: input.source,
        swarm: swarmEnabled() ? {
            n: swarm.flying().length,
            max: swarm.opts.maxWingmen,
            mode: swarm.mode,
            atk: swarm.attackers().length,
            id: droneId
        } : null,
        handover: !!handover,
        banner: banner && now < banner.until ? banner.text : ''
    }));
}

function ownPoses() {
    const poses = [];
    const viewing = handover ? handover.w.s : drone;
    if (drone && (settings.view !== 'fpv' || viewing !== drone)) { poses.push({ pos: drone.pos, q: drone.q, armed: drone.armed }); }
    swarm.wingmen.forEach(function (w) {
        if (settings.view === 'fpv' && w.s === viewing) { return; }
        poses.push({ pos: w.s.pos, q: w.s.q, armed: w.s.armed && !w.s.crashed });
    });
    return poses;
}

function frame(r) {
    const now = Date.now();

    if (status === 'pending' && now - pendingSince > 4000) {
        status = 'idle';
        notify('Server did not answer the FPV request', 'warn');
    }

    remotes.update(now);
    const camPos = fromVec3f(jcmp.localPlayer.camera.position);
    const poses = [];
    for (const k in remotes.list) {
        const rm = remotes.list[k];
        if (rm.pose) { poses.push({ pos: rm.pose.pos, q: rm.pose.q, armed: !!(rm.flags & FPV.FLAG_ARMED) }); }
    }
    if (status === 'flying' && drone) { Array.prototype.push.apply(poses, ownPoses()); }
    models.drawQuads(r, poses, camPos, settings.camera.modelRotSign, tune.cameraTiltDeg, now / 1000);
    drawRadios(r);
    recordFootprints(now);

    if (status !== 'flying' || !drone) { return; }

    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!(dt > 0)) { dt = 0; }
    if (dt > 0.1) { dt = 0.1; }   // hitch / alt-tab: don't explode
    if (dt > 0) { fps += (1 / dt - fps) * 0.05; }

    input.mode = settings.mode;
    input.altHold = settings.altHold;
    resolveInput(now, dt);

    acc += dt;
    while (acc >= STEP) {
        FPV.step(drone, input, world, tune, STEP);
        acc -= STEP;
    }
    if (drone.pos.y > cfg.maxAltitude) { drone.pos.y = cfg.maxAltitude; if (drone.vel.y > 0) { drone.vel.y = 0; } }

    probeTerrain(dt);

    while (drone.events.length) {
        const ev = drone.events.shift();
        if (ev.type === 'crash') { onOwnCrash(ev); }
    }

    // Wingmen.
    if (swarm.wingmen.length) {
        const targets = swarm.attackers().length ? gatherTargets() : {};
        swarm.update(dt, drone, world, targets);
        while (swarm.events.length) {
            const ev = swarm.events.shift();
            if (ev.type === 'impact') { sendImpact(ev.id, ev.pos, ev.speed); }
            else if (ev.type === 'lost') { notify('Wingman W' + ev.id + (ev.reason === 'WATER' ? ' ditched' : ' lost'), 'warn'); }
        }
    }
    if (handover) {
        if (handover.w.s.crashed || swarm.wingmen.indexOf(handover.w) < 0) {
            handover = null;
        } else if (swarm.aimError(handover.w) < 6 * FPV.DEG || now - handover.t0 > HANDOVER_MAX_MS) {
            finishHandover();
        }
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

function labels() {
    const out = [];
    for (const k in remotes.list) {
        const r = remotes.list[k];
        if (!r.pose || !(r.flags & FPV.FLAG_CONTROLLED)) { continue; }
        out.push({ pos: r.pose.pos, text: remotes.pilots[r.pilot] || ('Pilot ' + r.pilot),
            color: (r.flags & FPV.FLAG_ARMED) ? COLOR_ARMED : COLOR_NAME });
    }
    if (status === 'flying' && drone) {
        swarm.wingmen.forEach(function (w) {
            if (handover && w === handover.w) { return; }
            const tag = w.role === 'attack' ? 'W' + w.id + ' ATK' : (w.role === 'wreck' ? 'W' + w.id + ' X' : 'W' + w.id);
            out.push({ pos: w.s.pos, text: tag, size: 14,
                color: w.role === 'attack' ? COLOR_ATTACK : (w.role === 'wreck' ? COLOR_WRECK : COLOR_WING) });
        });
    }
    return out;
}

// ---- events: game ----------------------------------------------------------

jcmp.events.Add('GameUpdateRender', (r) => {
    try { frame(r); } catch (e) { log('frame error: ' + (e && e.stack ? e.stack : e)); }
});

jcmp.events.Add('Render', (r) => {
    try {
        const now = Date.now();
        while (effects.length && now - effects[0].t0 > 1000) { effects.shift(); }
        renderer.draw2d(r, labels(), effects, fromVec3f(jcmp.localPlayer.camera.position), now);
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

// Raw key state for keyboard flying (see updateKeyboardSticks).
jcmp.ui.AddEvent('fpv/ui/key', (code, down) => {
    keys[code] = !!down && !chatOpen;
});

// Controller sticks, already mapped/calibrated by the UI. Only sent while a
// controller is actually in use. arm/mode are -2 when no switch is mapped.
jcmp.ui.AddEvent('fpv/ui/sticks', (t, roll, pitch, yaw, arm, mode) => {
    padSticks = {
        t: FPV.clamp(+t || 0, 0, 1),
        r: FPV.clamp(+roll || 0, -1, 1),
        p: FPV.clamp(+pitch || 0, -1, 1),
        y: FPV.clamp(+yaw || 0, -1, 1)
    };
    padAt = Date.now();
    if (!drone || chatOpen) { return; }
    input.throttle = padSticks.t;   // so arming checks see the real stick

    // The arm switch acts on flips only, so E on the keyboard keeps working
    // and a switch left on at launch does not arm the quad by itself.
    if (arm > -1.5) {
        const on = arm > 0.5;
        if (armSwitchPrev !== null && on !== armSwitchPrev) { armRequest(on); }
        armSwitchPrev = on;
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
    if (isFinite(s.kbStrength)) { settings.kbStrength = FPV.clamp(+s.kbStrength, 0.1, 1); }
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
            if (Object.prototype.hasOwnProperty.call(c, k) && typeof c[k] === typeof cfg[k] && c[k] !== null) { cfg[k] = c[k]; }
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
    remotes.addPilot(id, name);
});

jcmp.events.AddRemoteCallable('fpv/remote_stop', (id) => { remotes.removePilot(id); });

jcmp.events.AddRemoteCallable('fpv/remote_swarm', (id, json) => {
    if (id === jcmp.localPlayer.networkId) { return; }
    let list;
    try { list = JSON.parse(json); } catch (e) { return; }
    if (Array.isArray(list)) { remotes.pushSwarm(id, Date.now(), list); }
});

jcmp.events.AddRemoteCallable('fpv/remote_crash', (name, reason) => {
    jcmp.ui.CallEvent('fpv/feed', name + (reason === 'WATER' ? ' ditched in the sea' : ' crashed'));
});

jcmp.events.AddRemoteCallable('fpv/remote_impact', (x, y, z) => {
    effects.push({ pos: { x: x, y: y, z: z }, t0: Date.now() });
    if (effects.length > 32) { effects.shift(); }
});

// Someone else's drone blew up next to one of ours.
jcmp.events.AddRemoteCallable('fpv/hit', (id, byName) => {
    if (!drone) { return; }
    if (id === droneId) {
        FPV.crash(drone, 'HIT');
        notify('Shot down by ' + byName, 'warn');
        return;
    }
    const w = swarm.wingmen.find(function (x) { return x.id === id; });
    if (w) { FPV.crash(w.s, 'HIT'); }
});
