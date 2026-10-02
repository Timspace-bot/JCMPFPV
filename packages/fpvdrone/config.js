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

    // The world only streams in around your character, so while you fly the
    // server moves your frozen character along underneath the drone every
    // `followDistance` metres, `followDepth` metres below it. Set
    // followDistance to 0 to disable (you will run out of streamed world).
    followDistance: 250,
    followDepth: 40,

    // Put the pilot's character back where they launched from when they exit
    // FPV mode. If false they are dropped at the last follow point.
    returnToLaunch: true,

    // Make the pilot's (frozen) character invulnerable while flying.
    invulnerableWhileFlying: true,

    // Analog video starts breaking up near this distance from the launch
    // point (purely cosmetic).
    videoRange: 2500,

    // Force physics values on every client (same keys as DEFAULT_TUNE in
    // src/client/physics.js), e.g. { thrustToWeight: 6, battery: { enabled: false } }.
    tuneOverrides: {}
};
