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
    this.probeValid = false;  // did the last lookAt sample line up with our camera?
    this.validSamples = 0;
};

FPV.World.prototype.reset = function () {
    this.pads = [];
    this.cells = {};
    this.cellCount = 0;
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

// Highest known surface at or just below `pos` (tolerance lets the quad sit
// on a surface whose sample was a few cm above its contact point).
FPV.World.prototype.floorAt = function (pos) {
    let y = this.seaLevel;
    let water = true;
    const tol = 0.5;

    for (let i = 0; i < this.pads.length; i++) {
        const p = this.pads[i];
        const dx = pos.x - p.x, dz = pos.z - p.z;
        if (dx * dx + dz * dz <= p.r * p.r && p.y <= pos.y + tol && p.y > y) {
            y = p.y; water = false;
        }
    }

    const list = this.cells[this.cellKey(pos.x, pos.z)];
    if (list) {
        for (let i = 0; i < list.length; i++) {
            if (list[i] <= pos.y + tol && list[i] > y) { y = list[i]; water = false; }
        }
    }
    return { y: y, water: water };
};

// Validate a lookAt point against the camera ray. Returns the hit distance
// along the ray, or -1 if the sample does not belong to our camera.
FPV.World.prototype.probe = function (camPos, camFwd, hit) {
    this.probeValid = false;
    if (!hit || !FPV.isFiniteVec(hit)) { return -1; }
    const d = FPV.sub(hit, camPos);
    const dist = FPV.len(d);
    if (dist < 0.05 || dist > 1500) { return -1; }
    const cos = FPV.dot(FPV.scale(d, 1 / dist), camFwd);
    if (cos < 0.9994) { return -1; }   // > ~2 degrees off our view ray
    if (Math.abs(hit.y - this.seaLevel) > 0.05) { this.addSample(hit); }
    this.probeValid = true;
    this.validSamples++;
    return dist;
};
