'use strict';
// FPV drone - server side.
// Approves launches, keeps the pilot's character safe and streamed in, and
// relays drone state between nearby players. Physics runs on each client.

const config = require('./config.js');

const pilots = new Map();   // networkId -> pilot record
const LOG = '[fpvdrone]';

function log(msg) { console.log(LOG + ' ' + msg); }

function clientConfig() {
    return JSON.stringify({
        enabled: config.enabled,
        seaLevel: config.seaLevel,
        syncRateHz: config.syncRateHz,
        followDistance: config.followDistance,
        followDepth: config.followDepth,
        videoRange: config.videoRange,
        maxAltitude: config.maxAltitude,
        tuneOverrides: config.tuneOverrides || {}
    });
}

function finite() {
    for (let i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] !== 'number' || !isFinite(arguments[i])) { return false; }
    }
    return true;
}

function dist2(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

// Where a player "is" for relevance purposes: their drone if flying.
function viewPoint(p) {
    const pilot = pilots.get(p.networkId);
    return pilot && pilot.pos ? pilot.pos : p.position;
}

function forEachOther(player, fn) {
    for (let i = 0; i < jcmp.players.length; i++) {
        const p = jcmp.players[i];
        if (p.networkId !== player.networkId) { fn(p); }
    }
}

function stopFlying(player, reason) {
    const pilot = pilots.get(player.networkId);
    if (!pilot) { return; }
    pilots.delete(player.networkId);
    try {
        if (config.invulnerableWhileFlying) { player.invulnerable = pilot.wasInvulnerable; }
        if (config.returnToLaunch && pilot.followed) { player.position = pilot.launch; }
    } catch (e) { /* player may already be gone */ }
    jcmp.events.CallRemote('fpv/remote_stop', null, player.networkId);
    if (reason) { jcmp.events.CallRemote('fpv/force_stop', player, reason); }
    log(player.name + ' landed');
}

// ---- client requests -------------------------------------------------------

jcmp.events.AddRemoteCallable('fpv/ready', (player) => {
    jcmp.events.CallRemote('fpv/config', player, clientConfig());
    pilots.forEach((pilot, id) => {
        jcmp.events.CallRemote('fpv/remote_start', player, id, pilot.name);
    });
});

jcmp.events.AddRemoteCallable('fpv/request_start', (player) => {
    if (!config.enabled) {
        jcmp.events.CallRemote('fpv/denied', player, 'FPV drones are disabled on this server');
        return;
    }
    if (player.vehicle) {
        jcmp.events.CallRemote('fpv/denied', player, 'Get out of the vehicle to launch your drone');
        return;
    }
    if (typeof player.health === 'number' && player.health <= 0) {
        jcmp.events.CallRemote('fpv/denied', player, 'You are dead');
        return;
    }
    if (pilots.has(player.networkId)) {
        jcmp.events.CallRemote('fpv/start', player);
        return;
    }
    const pos = player.position;
    pilots.set(player.networkId, {
        name: player.name,
        launch: new Vector3f(pos.x, pos.y, pos.z),
        pos: { x: pos.x, y: pos.y, z: pos.z },
        lastPacket: 0,
        followed: false,
        wasInvulnerable: !!player.invulnerable
    });
    if (config.invulnerableWhileFlying) { player.invulnerable = true; }
    jcmp.events.CallRemote('fpv/start', player);
    jcmp.events.CallRemote('fpv/remote_start', null, player.networkId, player.name);
    log(player.name + ' launched a drone');
});

jcmp.events.AddRemoteCallable('fpv/stop', (player) => {
    stopFlying(player, null);
});

jcmp.events.AddRemoteCallable('fpv/state', (player, x, y, z, qx, qy, qz, qw, armed, motor) => {
    const pilot = pilots.get(player.networkId);
    if (!pilot || !finite(x, y, z, qx, qy, qz, qw, motor)) { return; }

    // Rate limit to ~2x the configured send rate.
    const now = Date.now();
    if (now - pilot.lastPacket < 500 / config.syncRateHz) { return; }
    pilot.lastPacket = now;
    pilot.pos = { x: x, y: y, z: z };

    const range2 = config.syncRange * config.syncRange;
    forEachOther(player, (p) => {
        if (p.dimension !== player.dimension) { return; }
        if (dist2(viewPoint(p), pilot.pos) > range2) { return; }
        jcmp.events.CallRemote('fpv/remote_state', p, player.networkId, x, y, z, qx, qy, qz, qw, armed ? 1 : 0, motor);
    });
});

// Move the frozen character under the drone so the world keeps streaming.
jcmp.events.AddRemoteCallable('fpv/follow', (player, x, y, z, reset) => {
    const pilot = pilots.get(player.networkId);
    if (!pilot) { return; }
    if (reset) {
        player.position = pilot.launch;
        pilot.followed = false;
        pilot.pos = { x: pilot.launch.x, y: pilot.launch.y, z: pilot.launch.z };
        return;
    }
    if (!config.followDistance || !finite(x, y, z)) { return; }
    // Only follow to where the drone actually is (stops this being a teleport).
    if (dist2({ x: x, y: y, z: z }, pilot.pos) > 60 * 60) { return; }
    player.position = new Vector3f(x, y - config.followDepth, z);
    pilot.followed = true;
});

jcmp.events.AddRemoteCallable('fpv/crash', (player, reason) => {
    if (!pilots.has(player.networkId)) { return; }
    const r = reason === 'WATER' ? 'WATER' : 'IMPACT';
    const pilot = pilots.get(player.networkId);
    const range2 = config.syncRange * config.syncRange;
    forEachOther(player, (p) => {
        if (dist2(viewPoint(p), pilot.pos) <= range2) {
            jcmp.events.CallRemote('fpv/remote_crash', p, player.name, r);
        }
    });
});

// ---- game events -----------------------------------------------------------

jcmp.events.Add('PlayerDestroyed', (player) => {
    if (pilots.has(player.networkId)) {
        pilots.delete(player.networkId);
        jcmp.events.CallRemote('fpv/remote_stop', null, player.networkId);
    }
});

jcmp.events.Add('PlayerDeath', (player) => {
    stopFlying(player, 'You died - drone landed');
});

jcmp.events.Add('chat_command', (player, msg) => {
    if (config.chatCommand && typeof msg === 'string' && msg.trim().toLowerCase() === config.chatCommand) {
        jcmp.events.CallRemote('fpv/toggle', player);
        return false;
    }
});

// Other packages can query/stop pilots: jcmp.events.Call('fpv/IsFlying', player)
jcmp.events.Add('fpv/IsFlying', (player) => pilots.has(player.networkId));
jcmp.events.Add('fpv/ForceStop', (player, reason) => stopFlying(player, reason || 'Drone recalled'));

log('loaded (' + (config.enabled ? 'enabled' : 'disabled') + ')');
