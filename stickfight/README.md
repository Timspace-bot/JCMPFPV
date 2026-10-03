# Last Contract

A pixel-art stick-fighting game in one HTML file. Enemies come at you from both sides and you tap the side you want to strike. It's built for phones held upright (tuned on a Galaxy S23) and also plays in landscape and on desktop.

Open `index.html` in any modern browser. It has no build step and no dependencies. The pixel font loads from Google Fonts and falls back to monospace when offline.

## Controls

| Touch | Keyboard | Action |
|---|---|---|
| Tap a side | A / D, J / L or arrows | Strike the nearest enemy on that side |
| Hold a side | Hold A / D | Run that way. You stop as soon as an enemy is in reach |
| Tap both sides at once | Space, W or S | Ki attack (needs at least one full ki bar) |
| Top-right buttons | P / Esc, M | Pause, mute, music |

A white marker over an enemy means a tap will hit it. Tapping with nobody in range is a whiff: you lose your combo and you're open for half a second. Enemies flash and show a red **!** before they swing; a charger shows **!!** before it rushes you.

## Combos

- Every hit adds to your combo, and each 10 hits raises the score multiplier (up to x5).
- Bare-handed strikes cycle through jabs, crosses, high kicks, backfists, uppercuts, axe kicks, headbutts, spinning kicks, ki palms, flying knees, superman punches, sweeps and throws.
- Hitting right after a run turns into a dropkick or superman punch with extra damage.
- Fast strings get a name and bonus points and ki:

| String | How |
|---|---|
| Triple Threat | Three quick hits on the same side. The third hit launches the enemy into the air if it doesn't kill them |
| Sky Juggler | Three hits on airborne enemies. Tap a launched enemy's side to jump up and keep them in the air |
| Crossfire | Alternate sides four times: L R L R |
| Pendulum | L L R R or R R L L |
| Hurricane | Six hits in about a second and a half |

- **Ascended:** every 30-hit combo turns your hair gold for 10 seconds. You get double damage, more reach and faster ki.

## Ki attacks

Hits, kills, parries and named combos fill three ki bars. Triggering a ki attack spends every full bar you have:

| Bars | Attack |
|---|---|
| 1 | **Ki Blast.** An energy ball each way that explodes on the first enemy it hits |
| 2 | **Dragon Rush.** You teleport between up to 8 enemies on screen, hitting each one |
| 3 | **Spirit Cannon.** Charge up, then fire a full-screen beam at the side with more enemies. The other side gets blown back |

## Enemies

| Colour | Enemy | Behaviour |
|---|---|---|
| Red | Grunt | Goes down in one hit |
| Orange | Brawler | Bigger, takes 3 hits |
| Cyan | Dodger | Flips over you after the first hit, so finish him on the other side |
| Yellow | Gunman | Keeps his distance and aims a laser. Tap his side to slide-tackle him, or tap toward an incoming bullet to parry it back |
| Steel blue | Shield | His shield stops bullets and your first light hit (guard break). Heavy weapons, explosions and ki go straight through |
| Green | Ninja | Fast. Throws a shuriken (parryable) and sometimes vanishes from a hit and reappears behind you |
| Pink | Charger | 4 HP. Revs up, then rushes you for 2 damage. Hit him mid-charge for a double-damage counter |
| Purple | Enforcer | Boss every 5th contract. 14 HP, hits for 2, jumps sides and throws knives |

Difficulty rises each contract. Enemies get faster and wind up quicker, more of them are on screen at once, and from contract 3 they come at you from both sides together. Clearing a contract gives a score bonus, but only every second contract restores a heart.

## Weapons

Weapons drop from enemies and fall from the sky. Walk over one, or tap toward it to dash for it.

| Weapon | Uses | Effect |
|---|---|---|
| Pistol | 8 | Hits the nearest enemy on that side anywhere on screen |
| Dual pistols | 16 | Same, but faster |
| Shotgun | 4 | Hits every enemy on that side within close range |
| Katana | 12 | Longer reach, cuts through two enemies |
| Nunchaku | 18 | Fast two-hit flurries |
| Sledgehammer | 6 | Slow, huge damage, also hits the enemy behind |
| Tomahawks | 4 | Thrown at the nearest enemy on that side |
| Grenades | 3 | Lobbed at the nearest enemy, blast hits everyone nearby |
| Pencil | 3 | Kills anything in one hit |
