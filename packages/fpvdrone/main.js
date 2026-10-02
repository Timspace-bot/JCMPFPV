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
        tuneOverrides: config.tuneOverrides || {},
        swarm: config.swarm || { enabled: false },
        damage: { enabled: !!(config.damage && config.damage.enabled), minSpeed: config.damage ? config.damage.minSpeed : 10 }
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
        drones: new Map(),
        impacts: [],
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

const MAX_DRONES_PER_PACKET = 24;

// Batched state for the pilot's whole swarm:
// JSON [[droneId, x, y, z, qx, qy, qz, qw, flags], ...]  (flags: 1 armed, 2 controlled, 4 crashed)
jcmp.events.AddRemoteCallable('fpv/swarm', (player, json) => {
    const pilot = pilots.get(player.networkId);
    if (!pilot || typeof json !== 'string' || json.length > 8192) { return; }

    // Rate limit to ~2x the configured send rate.
    const now = Date.now();
    if (now - pilot.lastPacket < 500 / config.syncRateHz) { return; }

    let list;
    try { list = JSON.parse(json); } catch (e) { return; }
    if (!Array.isArray(list)) { return; }
    const clean = [];
    const drones = new Map();
    for (let i = 0; i < list.length && clean.length < MAX_DRONES_PER_PACKET; i++) {
        const e = list[i];
        if (!Array.isArray(e) || e.length !== 9) { continue; }
        if (!finite(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8])) { continue; }
        const id = e[0] | 0;
        const flags = e[8] & 7;
        clean.push([id, e[1], e[2], e[3], e[4], e[5], e[6], e[7], flags]);
        drones.set(id, { x: e[1], y: e[2], z: e[3], crashed: !!(flags & 4) });
        if (flags & 2) { pilot.pos = { x: e[1], y: e[2], z: e[3] }; pilot.controlled = id; }
    }
    if (!clean.length) { return; }
    pilot.lastPacket = now;
    pilot.drones = drones;

    const out = JSON.stringify(clean);
    const range2 = config.syncRange * config.syncRange;
    forEachOther(player, (p) => {
        if (p.dimension !== player.dimension) { return; }
        if (dist2(viewPoint(p), pilot.pos) > range2) { return; }
        jcmp.events.CallRemote('fpv/remote_swarm', p, player.networkId, out);
    });
});

// A drone (the pilot's or a wingman) hit something hard. Validate that one
// of this pilot's drones really is there, then apply area damage.
jcmp.events.AddRemoteCallable('fpv/impact', (player, droneId, x, y, z, speed) => {
    const pilot = pilots.get(player.networkId);
    const dmg = config.damage || {};
    if (!pilot || !dmg.enabled || !finite(droneId, x, y, z, speed) || speed < dmg.minSpeed) { return; }

    const now = Date.now();
    pilot.impacts = (pilot.impacts || []).filter((t) => now - t < 4000);
    if (pilot.impacts.length >= 8) { return; }

    const at = { x: x, y: y, z: z };
    const d = pilot.drones && pilot.drones.get(droneId | 0);
    if (!d || dist2(d, at) > 40 * 40) { return; }
    pilot.impacts.push(now);

    const r = dmg.radius;
    const scale = Math.min(1, speed / 25);   // a fast hit does full damage

    for (let i = 0; i < jcmp.players.length; i++) {
        const p = jcmp.players[i];
        if (p.networkId === player.networkId || pilots.has(p.networkId) || p.dimension !== player.dimension) { continue; }
        if (p.invulnerable || typeof p.health !== 'number' || p.health <= 0) { continue; }
        const dd = Math.sqrt(dist2(p.position, at));
        if (dd > r) { continue; }
        p.health = Math.max(0, p.health - Math.round(dmg.playerDamage * scale * (1 - dd / r)));
    }

    if (jcmp.vehicles && dmg.vehicleDamage > 0) {
        for (let i = 0; i < jcmp.vehicles.length; i++) {
            const v = jcmp.vehicles[i];
            if (!v || typeof v.health !== 'number' || (v.dimension !== undefined && v.dimension !== player.dimension)) { continue; }
            const dd = Math.sqrt(dist2(v.position, at));
            if (dd > r + 2) { continue; }   // vehicles are big; measure from their centre
            const max = v.maxHealth || v.max_health || Math.max(v.health, 1000);
            v.health = Math.max(0, v.health - dmg.vehicleDamage * max * scale * (1 - dd / (r + 2)));
        }
    }

    if (dmg.hitDrones) {
        pilots.forEach((other, otherId) => {
            if (otherId === player.networkId && !dmg.hitPilotsOwnDrones) { return; }
            if (!other.drones) { return; }
            other.drones.forEach((od, odId) => {
                if (otherId === player.networkId && odId === (droneId | 0)) { return; }
                if (!od.crashed && dist2(od, at) <= r * r) {
                    const target = jcmp.players.find((p) => p.networkId === otherId);
                    if (target) { jcmp.events.CallRemote('fpv/hit', target, odId, player.name); }
                }
            });
        });
    }

    const range2 = config.syncRange * config.syncRange;
    for (let i = 0; i < jcmp.players.length; i++) {
        const p = jcmp.players[i];
        if (p.dimension === player.dimension && dist2(viewPoint(p), at) <= range2) {
            jcmp.events.CallRemote('fpv/remote_impact', p, x, y, z);
        }
    }
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
    // Only follow to where the controlled drone actually is (stops this being a teleport).
    if (dist2({ x: x, y: y, z: z }, pilot.pos) > 120 * 120) { return; }
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
