# Last Contract

A pixel-art stick-fighting game in one HTML file. Enemies come at you from both sides and you tap the side you want to strike. It's built for phones held upright (tuned on a Galaxy S23) and also plays in landscape and on desktop.

Open `index.html` in any modern browser. It has no build step and no dependencies. The pixel font loads from Google Fonts and falls back to monospace when offline.

## How to play

- **Tap the left or right half of the screen** to strike the nearest enemy on that side. On a keyboard, use A / D, J / L or the arrow keys.
- A white marker over an enemy means a tap will hit it. If you tap with nobody in range, you whiff, lose your combo and are left open for a moment.
- Enemies flash and show a red **!** before they swing. Hit them first, or they take a heart.
- Every hit adds to your combo. The moves chain through jabs, crosses, high kicks, uppercuts, spinning kicks, flying knees, sweeps and over-the-shoulder throws, and every 10 hits raises the score multiplier (up to x5).
- Thrown bodies knock down whoever they land on.

### Enemies

| Colour | Enemy | Behaviour |
|---|---|---|
| Red | Grunt | Goes down in one hit |
| Orange | Brawler | Bigger, takes 3 hits, staggers back after each one |
| Cyan | Dodger | Flips over you after the first hit, so finish him on the other side |
| Yellow | Gunman | Keeps his distance and aims a laser. Tap his side to slide-tackle him, or tap toward an incoming bullet to parry it back |
| Purple | Enforcer | Boss every 5th contract. 10 HP, jumps sides and throws knives |

### Weapons

Weapons drop from enemies and fall from the sky. Walk over one to pick it up, or tap toward it to dash for it.

| Weapon | Ammo | Effect |
|---|---|---|
| Pistol | 8 | Hits the nearest enemy on that side anywhere on screen |
| Shotgun | 4 | Hits every enemy on that side within close range |
| Katana | 12 | Longer reach, cuts through two enemies at once |
| Pencil | 3 | Kills anything in one hit |

Clearing a contract (wave) restores a heart and gives a score bonus. P or Esc pauses, and M mutes. The music and sound buttons are in the top-right corner.
