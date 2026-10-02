// ---------------------------------------------------------------------------
// world.js - what the drone remembers about the world's surfaces.
//
// JC3MP's scripting API has no physics query. Live collision comes from Rico's
// body (see the collision proxy in client.js); everything it touches, and
// everywhere a character has stood, is remembered here so that wingmen and
// later flights collide with it too:
//   * sea level (water = crash),
//   * pads: known ground at the launch spot / crash sites,
//   * ground samples: a heightfield of 2 m cells (floor lookups search ~5 m),
//   * solid points: wall/tree/building contacts, 0.35 m spheres.
// ---------------------------------------------------------------------------

FPV.World = function (seaLevel) {
    this.seaLevel = seaLevel;
    this.pads = [];
    this.cells = {};          // "cx:cz" -> [y, ...] surface heights in that cell
    this.cellCount = 0;
    this.cellSize = 2.0;
    this.maxCells = 30000;
    this.searchCells = 2;     // floor lookups also consider samples up to 2 cells (~5 m) away
    // Solid points: wall/tree/building contacts reported by the game's physics
    // (see the Rico collision proxy in client.js). Quads collide with them.
    this.solids = {};         // "x:y:z" (1 m cells) -> [{x,y,z}, ...]
    this.solidCount = 0;
    this.maxSolids = 250000;
    this.solidRadius = 0.35;  // each point acts as a small sphere
    this.lastSrc = 'sea';
};

// Forget pads (per flight). Terrain samples are kept for the whole session:
// the ground does not move, so everything learned stays useful.
FPV.World.prototype.reset = function () {
    this.pads = [];
};

FPV.World.prototype.addPad = function (x, y, z, radius) {
    this.pads.push({ x: x, y: y, z: z, r: radius });
    if (this.pads.length > 64) { this.pads.shift(); }
};

FPV.World.prototype.cellKey = function (x, z) {
    return Math.floor(x / this.cellSize) + ':' + Math.floor(z / this.cellSize);
};

FPV.World.prototype.addSample = function (p) {
    const key = this.cellKey(p.x, p.z);
    let list = this.cells[key];
    if (!list) {
        if (this.cellCount >= this.maxCells) { this.cells = {}; this.cellCount = 0; }
        list = this.cells[key] = [];
        this.cellCount++;
    }
    for (let i = 0; i < list.length; i++) {
        if (Math.abs(list[i] - p.y) < 1.0) { list[i] = p.y; return; }   // refresh existing layer
    }
    list.push(p.y);
    if (list.length > 4) { list.shift(); }
};

// Highest known surface at or just below `pos`. Surfaces sampled within a
// few metres count too (terrain is continuous, and a single 2 m cell is easy
// to miss), and the tolerance lets the quad sit on a surface whose sample was
// a few cm above its contact point.
FPV.World.prototype.floorAt = function (pos) {
    let y = this.seaLevel;
    let water = true;
    let src = 'sea';
    const tol = 0.5;

    for (let i = 0; i < this.pads.length; i++) {
        const p = this.pads[i];
        const dx = pos.x - p.x, dz = pos.z - p.z;
        if (dx * dx + dz * dz <= p.r * p.r && p.y <= pos.y + tol && p.y > y) {
            y = p.y; water = false; src = 'pad';
        }
    }

    const cs = this.cellSize;
    const cx = Math.floor(pos.x / cs), cz = Math.floor(pos.z / cs);
    const R = this.searchCells;
    for (let ix = -R; ix <= R; ix++) {
        for (let iz = -R; iz <= R; iz++) {
            const list = this.cells[(cx + ix) + ':' + (cz + iz)];
            if (!list) { continue; }
            for (let i = 0; i < list.length; i++) {
                if (list[i] <= pos.y + tol && list[i] > y) { y = list[i]; water = false; src = 'map'; }
            }
        }
    }
    this.lastSrc = src;
    return { y: y, water: water };
};

// Ground truth from something standing on the ground (Rico's feet, other
// players on foot): stored as a sample plus a small pad.
FPV.World.prototype.addGround = function (x, y, z) {
    this.addSample({ x: x, y: y, z: z });
};

FPV.World.prototype.sampleCount = function () { return this.cellCount; };

FPV.World.prototype.solidKey = function (x, y, z) {
    return Math.floor(x) + ':' + Math.floor(y) + ':' + Math.floor(z);
};

FPV.World.prototype.addSolid = function (p) {
    const key = this.solidKey(p.x, p.y, p.z);
    let list = this.solids[key];
    if (!list) {
        if (this.solidCount >= this.maxSolids) { this.solids = {}; this.solidCount = 0; }
        list = this.solids[key] = [];
    }
    for (let i = 0; i < list.length; i++) {
        const q = list[i];
        const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        if (dx * dx + dy * dy + dz * dz < 0.04) { return; }   // already have one within 20 cm
    }
    if (list.length >= 8) { list.shift(); this.solidCount--; }
    list.push({ x: p.x, y: p.y, z: p.z });
    this.solidCount++;
};

// Deepest contact between a sphere (pos, r) and the known solid points, as
// {normal, depth}, or null. Like a character capsule: push out along the
// normal, the caller decides between sliding/bouncing and crashing.
FPV.World.prototype.collide = function (pos, r) {
    const reach = r + this.solidRadius;
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    let best = null;
    for (let ix = -1; ix <= 1; ix++) {
        for (let iy = -1; iy <= 1; iy++) {
            for (let iz = -1; iz <= 1; iz++) {
                const list = this.solids[(bx + ix) + ':' + (by + iy) + ':' + (bz + iz)];
                if (!list) { continue; }
                for (let i = 0; i < list.length; i++) {
                    const q = list[i];
                    const dx = pos.x - q.x, dy = pos.y - q.y, dz = pos.z - q.z;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 >= reach * reach) { continue; }
                    const d = Math.sqrt(d2);
                    const depth = reach - d;
                    if (!best || depth > best.depth) {
                        best = { depth: depth, normal: d > 1e-6 ? { x: dx / d, y: dy / d, z: dz / d } : { x: 0, y: 1, z: 0 } };
                    }
                }
            }
        }
    }
    return best;
};
