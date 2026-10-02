// FPV drone server settings. Restart the server (or the package) after editing.
module.exports = {
    // Master switch. When false nobody can launch a drone.
    enabled: true,

    // Chat command that toggles FPV mode (needs a chat package that emits
    // 'chat_command', e.g. the default JC3MP chat). Set to '' to disable.
    chatCommand: '/fpv',

    // Height of the sea surface in JC3 world units. Flying below it is a crash.
    seaLevel: 1024,

    // Hard ceiling for drones (world Y).
    maxAltitude: 4500,

    // How often each pilot sends their drone state (Hz) and how far away
    // (metres) other players receive it.
    syncRateHz: 20,
    syncRange: 1500,

    // Rico stays standing where he launched from, radio in hand. Optionally the
    // server can drag the (frozen) character along under the drone every
    // `followDistance` metres (`followDepth` below it) so the world keeps
    // streaming in on very long flights - but then he is no longer visible at
    // the launch spot. 0 = never move him.
    followDistance: 0,
    followDepth: 40,

    // Put the pilot's character back where they launched from when they exit
    // FPV mode (only matters if followDistance moved him).
    returnToLaunch: true,

    // Make the pilot's (frozen) character invulnerable while flying.
    invulnerableWhileFlying: true,

    // Analog video starts breaking up near this distance from the launch
    // point (purely cosmetic).
    videoRange: 2500,

    // AI wingmen. Pilots call them in with a button, they fly in formation,
    // circle (at least orbitMinHeight above the target) while the pilot dives,
    // and take over control when the pilot's drone impacts.
    swarm: {
        enabled: true,
        maxWingmen: 5,
        orbitMinHeight: 25,     // metres above the attack point
        orbitRadius: 35,
        orbitSpeed: 11,
        formationMinHeight: 4,
        cruiseSpeed: 60,
        attackSpeed: 50,
        attackRadius: 150,      // swarm-attack picks targets within this range of the pilot's drone
        wreckSeconds: 15
    },

    // What a drone impact does. Damage is applied server-side around the
    // impact point (player health is 0-800 in JC3MP).
    damage: {
        enabled: true,
        minSpeed: 10,           // m/s - slower crashes do nothing
        radius: 6,              // metres
        playerDamage: 350,      // at the centre, falls off linearly to the edge
        vehicleDamage: 0.4,     // fraction of the vehicle's max health at the centre
        hitDrones: true,        // impacts also knock down other pilots' drones in range
        hitPilotsOwnDrones: false
    },

    // Force physics values on every client (same keys as DEFAULT_TUNE in
    // src/client/physics.js), e.g. { thrustToWeight: 6, battery: { enabled: false } }.
    tuneOverrides: {}
};
