# JCMPFPV: FPV drone swarm for Just Cause 3 Multiplayer

A [JC3MP](https://just-cause.mp) package that lets you fly an FPV quadcopter in Just Cause 3, either with a real RC transmitter (RadioMaster, or any EdgeTX/OpenTX radio in USB joystick mode), a gamepad, or the keyboard. You can also call in AI wingmen that fly as a swarm.

- **Real quad physics.** It's a rigid-body model with thrust, drag, motor lag, battery sag, Betaflight rates (RC rate, super rate, expo), a throttle mid/expo curve, and acro, angle and horizon modes. Altitude assist makes keyboard flying possible.
- **Betaflight-style OSD.** Shows mode, flight timer, speed, altitude, vertical speed, voltage, mAh, amps, throttle, a home arrow, an artificial horizon and warnings. Analog video breaks up as you fly out of range.
- **Multiplayer.** Everyone in range sees every drone, interpolated, with name tags.
- **Swarm.** Wingmen fly a dynamic formation. While you dive they circle the target, and when your drone impacts, control hands over to whichever wingman is looking at the impact point. A swarm-attack command sends them all at targets.

## Install

The mod doesn't modify any game files. You don't need to touch `B:\SteamLibrary\steamapps\common\Just Cause 3`. JC3MP downloads client packages from the server you join.

1. In Steam, install **Just Cause 3: Multiplayer Mod** and its **Dedicated Server** tool. In your library they live next to the game, under `B:\SteamLibrary\steamapps\common\`.
2. Double-click **`install.bat`** in this repo. It finds the dedicated server under `B:\SteamLibrary\steamapps\common`, copies `packages/fpvdrone` into its `packages` folder (keeping your edited `config.js` on reinstall) and starts the server. If it can't find the server, run `tools\install.ps1 -ServerDir "<server folder>"`. To install by hand, copy `packages/fpvdrone` into the server's `packages` folder so you end up with `...\packages\fpvdrone\main.js`.
3. Start the server, launch JC3MP and connect to it. To play solo, connect to `127.0.0.1`.
4. Server options are in `packages/fpvdrone/config.js`. They cover the swarm size, orbit height, attack radius, damage, sea level, sync range and whether the character follows the drone.

## Controls

| Key | Action |
|---|---|
| **F7** | Launch the drone or exit FPV mode. `/fpv` in chat also works. |
| **F8** | Settings: controller mapping and calibration, rates, quad, camera, keybinds |
| **E** | Arm / disarm (arming needs throttle low, like a real FC) |
| **R** | Reset the drone to the launch point |
| **M** / **H** / **V** | Cycle flight mode / altitude assist / view (FPV, chase, line-of-sight) |
| **C** | Swarm: call in a wingman |
| **G** | Swarm: attack everything nearby (press again to call it off) |
| **N** | Swarm: switch to the next drone |
| W/S, A/D, arrow keys | Throttle, yaw, pitch and roll on the keyboard |

All keys can be rebound in F8 → Keys.

### RadioMaster / RC transmitter

1. Plug the radio in over USB and choose **USB Joystick (HID)**. Press any switch so the game sees it.
2. Open F8 → Controls and click **RC transmitter (AETR)**. Then use **Detect** on each row and move the matching stick or switch.
3. Click **Calibrate sticks**, sweep every stick and switch through its full range, then centre the sticks.
4. Map **Arm** to your arm switch and **Mode** to a 3-position switch: low is acro, middle is horizon, high is angle. Map **Call**, **Attack** and **Switch** to any buttons or momentary switches. On a RadioMaster, set **SH** (momentary) to an output channel in the mixer and Detect it as **Call**.

By default the preset reads Call from channel 7 (axis 6) and Attack from channel 8 (axis 7). Commands fire on the rising edge of a switch, and a switch that's already on when you load in doesn't fire.

## Swarm

- **Call (C / your button).** A wingman takes off from your launch point and flies to you. If you're more than 600 m from home, it arrives from behind instead. It joins a formation that changes with how you fly: a wedge behind you while you're moving, and a slow ring around you while you hover. Wingmen stay at least `formationMinHeight` above known ground. The default limit is 5 wingmen.
- **Diving at something.** Once you commit to a steep dive, the wingmen break off and circle the point you're heading for. They stay at least `orbitMinHeight` (25 m) above it and keep their cameras facing the centre.
- **Impact → handover.** When your drone crashes, control jumps to the wingman whose camera is best lined up on the impact point. It gets up to 0.9 s to pitch its camera onto the spot under autopilot (the OSD shows `LINK > W3 AUTO-AIM`), then the sticks are yours again for the next attack. The other wingmen keep circling until you climb back out, then they rejoin the formation.
- **Attack (G / your button).** Every wingman picks a player, vehicle or other pilot's drone within `attackRadius` (150 m), leads it and rams it.
- **Damage.** Impacts at 10 m/s or more damage players and vehicles within a 6 m radius, and knock other pilots' drones out of the sky. The server applies it and checks the impact against where your drones actually are. You can turn damage off in `config.js`.

## Development

Edit the client code in `src/client/*.js`, then rebuild. The build bundles it into `packages/fpvdrone/client_package/main.js`, which is committed so the package works when you copy it.

```
npm run build      # bundle the client
npm test           # build + unit and integration tests (Node 18+)
npm run textures   # regenerate the drone/explosion PNGs
```

The tests cover the physics, the autopilot and swarm behaviours, and the full server and client flow against a mocked JC3MP runtime. That flow is launch, arm, fly, call wingmen, crash and hand over, swarm attack, and server damage.

## Limitations and first-flight calibration

None of this has been run inside the game yet. It's built against the JC3MP API as used by published packages (freecam, chat and Survival Island), and tested against a mock of that API. Expect some first-run tuning:

- **Camera orientation.** JC3MP takes camera rotation as Euler angles, and the sign conventions were inferred from existing freecam code. If rolling or pitching turns the picture the wrong way, flip it in F8 → Camera. You only need to do this once and it's saved.
- **Terrain collision.** JC3MP's client API has no raycast. The drone collides with sea level (water counts as a crash), with your launch spot, and with surfaces sampled from the game's aim ray (`localPlayer.lookAt`). Each sample is only kept if it lines up with your camera. In FPV you nearly always look at the ground ahead, so terrain gets mapped before you reach it. Wingmen use the same map, so they can clip terrain nobody has looked at.
- **Damage scale.** Player health in JC3MP runs 0–800. Vehicle max health isn't exposed consistently, so vehicle damage is a fraction of `maxHealth`, falling back to 1000.
- **Your character.** It stays frozen and invulnerable while you fly. It gets moved under the drone every 250 m so the world keeps streaming, and goes back to the launch point when you exit.
