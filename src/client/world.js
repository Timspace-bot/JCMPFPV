// ---------------------------------------------------------------------------
// world.js - what the drone can collide with.
//
// JC3MP's client API has no physics raycast, so the floor is built from:
//   * sea level (water = crash),
//   * "pads": known-good ground points (the launch spot under your feet,
//     crash sites),
//   * surface samples from jcmp.localPlayer.lookAt - the game's own aim ray.
//     While the camera is detached that ray *may* follow our camera; every
//     sample is checked against the camera ray and discarded if it does not
//     line up, so a game build where lookAt does not follow simply falls back
//     to pads + sea level. In FPV you are almost always looking at the ground
//     ahead of you, so the terrain you are about to fly over gets sampled
//     before you get there.
// ---------------------------------------------------------------------------

FPV.World = function (seaLevel) {
    this.seaLevel = seaLevel;
    this.pads = [];
    this.cells = {};          // "cx:cz" -> [y, ...] surface heights in that cell
    this.cellCount = 0;
    this.cellSize = 2.0;
    this.maxCells = 30000;
    this.searchCells = 2;     // floor lookups also consider samples up to 2 cells (~5 m) away
    // Solid points: every surface the aim ray has hit (walls, trees, rocks,
    // buildings, ground). The quad collides with them like a character does.
    this.solids = {};         // "x:y:z" (1 m cells) -> [{x,y,z}, ...]
    this.solidCount = 0;
    this.maxSolids = 250000;
    this.solidRadius = 0.35;  // each hit point acts as a small sphere
    this.probeValid = false;  // did the last lookAt sample line up with our camera?
    this.validSamples = 0;
    this.probeTries = 0;
    this.lastOffDeg = -1;     // last lookAt's angle off our camera ray (diagnostics)
    this.lastHitDist = -1;
    this.recent = [];         // 1 = aligned, 0 = not, for the last ~2 s of frames
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

// Share of recent frames where the aim ray lined up with our camera.
FPV.World.prototype.probeRatio = function () {
    if (!this.recent.length) { return 0; }
    let n = 0;
    for (let i = 0; i < this.recent.length; i++) { n += this.recent[i]; }
    return n / this.recent.length;
};

// Feed one lookAt point. `cams` are the camera poses we set over the last few
// frames ({pos, fwd}); the game may answer with a frame or two of lag. If the
// point lines up with one of them, the aim ray follows our camera and it is a
// real surface hit: it becomes a floor sample and a solid point. Returns the
// hit distance along the matching ray, or -1.
FPV.World.prototype.probe = function (cams, hit) {
    this.probeValid = false;
    this.probeTries++;
    let aligned = 0;
    let bestCos = -2, bestDist = -1;
    if (hit && FPV.isFiniteVec(hit) && !(hit.x === 0 && hit.y === 0 && hit.z === 0)) {
        for (let i = 0; i < cams.length; i++) {
            const d = FPV.sub(hit, cams[i].pos);
            const dist = FPV.len(d);
            if (dist < 0.05) { continue; }
            const cos = FPV.dot(FPV.scale(d, 1 / dist), cams[i].fwd);
            if (cos > bestCos) { bestCos = cos; bestDist = dist; }
        }
        if (bestCos > -2) {
            this.lastOffDeg = Math.acos(FPV.clamp(bestCos, -1, 1)) / FPV.DEG;
            this.lastHitDist = bestDist;
            aligned = bestCos >= 0.9986 && bestDist < 1200 ? 1 : 0;   // within ~3 degrees
        }
    }
    this.recent.push(aligned);
    if (this.recent.length > 120) { this.recent.shift(); }
    if (!aligned) { return -1; }
    if (Math.abs(hit.y - this.seaLevel) > 0.05) {
        this.addSample(hit);
        this.addSolid(hit);
    }
    this.probeValid = true;
    this.validSamples++;
    return bestDist;
};
