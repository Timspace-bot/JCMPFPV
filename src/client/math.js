// ---------------------------------------------------------------------------
// math.js - vector / quaternion helpers.
//
// Everything here works on plain {x, y, z} / {x, y, z, w} objects so it can be
// unit-tested in Node without the JC3MP runtime. Conversion to the game's
// Vector3f happens only at the edges (client.js / remote.js).
//
// Frames (right-handed, Y up - matches JC3 world space):
//   world: +X east, +Y up, +Z south
//   body : +X right, +Y up, -Z forward (nose)
// ---------------------------------------------------------------------------

FPV.v3 = function (x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; };
FPV.add = function (a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; };
FPV.sub = function (a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; };
FPV.scale = function (a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; };
FPV.dot = function (a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; };
FPV.cross = function (a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
};
FPV.len = function (a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); };
FPV.dist = function (a, b) { return FPV.len(FPV.sub(a, b)); };
FPV.norm = function (a) {
    const l = FPV.len(a);
    return l > 1e-9 ? FPV.scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
FPV.lerp3 = function (a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
};
FPV.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
FPV.isFiniteVec = function (a) {
    return a && isFinite(a.x) && isFinite(a.y) && isFinite(a.z);
};

FPV.DEG = Math.PI / 180;

// ---- quaternions (Hamilton, q = w + xi + yj + zk) --------------------------

FPV.qIdentity = function () { return { x: 0, y: 0, z: 0, w: 1 }; };

FPV.qMul = function (a, b) {
    return {
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    };
};

FPV.qConj = function (q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; };

FPV.qNorm = function (q) {
    const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (l < 1e-12) { return FPV.qIdentity(); }
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
};

FPV.qAxisAngle = function (axis, angle) {
    const n = FPV.norm(axis);
    const s = Math.sin(angle / 2);
    return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
};

// Rotate vector v by unit quaternion q (body -> world when q is the attitude).
FPV.qRotate = function (q, v) {
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
        x: v.x + q.w * tx + (q.y * tz - q.z * ty),
        y: v.y + q.w * ty + (q.z * tx - q.x * tz),
        z: v.z + q.w * tz + (q.x * ty - q.y * tx)
    };
};

// Integrate body-frame angular velocity w (rad/s) over dt.
FPV.qIntegrateBody = function (q, w, dt) {
    const ang = FPV.len(w) * dt;
    if (ang < 1e-12) { return q; }
    const dq = FPV.qAxisAngle(w, ang);
    return FPV.qNorm(FPV.qMul(q, dq));
};

FPV.qSlerp = function (a, b, t) {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cos > 0.9995) {
        return FPV.qNorm({
            x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t,
            z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t
        });
    }
    const theta = Math.acos(cos);
    const s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s;
    const wb = Math.sin(t * theta) / s;
    return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
};

// Returns {axis, angle} for use with the game's Matrix.Rotate(angle, axis).
FPV.qToAxisAngle = function (q) {
    q = FPV.qNorm(q);
    if (q.w < 0) { q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w }; }
    const angle = 2 * Math.acos(FPV.clamp(q.w, -1, 1));
    const s = Math.sqrt(1 - q.w * q.w);
    if (s < 1e-6) { return { axis: { x: 0, y: 1, z: 0 }, angle: 0 }; }
    return { axis: { x: q.x / s, y: q.y / s, z: q.z / s }, angle: angle };
};

// Row-major 3x3 rotation matrix (m[row][col]); columns are the body axes in world.
FPV.qToMat = function (q) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    ];
};

// ---- Euler angles ----------------------------------------------------------
// `order` names the intrinsic rotation sequence, e.g. 'YXZ' means
// R = Ry(e.y) * Rx(e.x) * Rz(e.z)  (yaw, then pitch, then roll).
// Formulas follow three.js Euler.setFromRotationMatrix.

FPV.eulerFromQuat = function (q, order) {
    const m = FPV.qToMat(q);
    const m11 = m[0][0], m12 = m[0][1], m13 = m[0][2];
    const m21 = m[1][0], m22 = m[1][1], m23 = m[1][2];
    const m31 = m[2][0], m32 = m[2][1], m33 = m[2][2];
    const c = FPV.clamp;
    const e = { x: 0, y: 0, z: 0 };
    switch (order) {
        case 'XYZ':
            e.y = Math.asin(c(m13, -1, 1));
            if (Math.abs(m13) < 0.9999999) { e.x = Math.atan2(-m23, m33); e.z = Math.atan2(-m12, m11); }
            else { e.x = Math.atan2(m32, m22); e.z = 0; }
            break;
        case 'YXZ':
            e.x = Math.asin(-c(m23, -1, 1));
            if (Math.abs(m23) < 0.9999999) { e.y = Math.atan2(m13, m33); e.z = Math.atan2(m21, m22); }
            else { e.y = Math.atan2(-m31, m11); e.z = 0; }
            break;
        case 'ZXY':
            e.x = Math.asin(c(m32, -1, 1));
            if (Math.abs(m32) < 0.9999999) { e.y = Math.atan2(-m31, m33); e.z = Math.atan2(-m12, m22); }
            else { e.y = 0; e.z = Math.atan2(m21, m11); }
            break;
        case 'ZYX':
            e.y = Math.asin(-c(m31, -1, 1));
            if (Math.abs(m31) < 0.9999999) { e.x = Math.atan2(m32, m33); e.z = Math.atan2(m21, m11); }
            else { e.x = 0; e.z = Math.atan2(-m12, m22); }
            break;
        case 'YZX':
            e.z = Math.asin(c(m21, -1, 1));
            if (Math.abs(m21) < 0.9999999) { e.x = Math.atan2(-m23, m22); e.y = Math.atan2(-m31, m11); }
            else { e.x = 0; e.y = Math.atan2(m13, m33); }
            break;
        case 'XZY':
            e.z = Math.asin(-c(m12, -1, 1));
            if (Math.abs(m12) < 0.9999999) { e.x = Math.atan2(m32, m22); e.y = Math.atan2(m13, m11); }
            else { e.x = Math.atan2(-m23, m33); e.y = 0; }
            break;
        default:
            throw new Error('Unknown euler order ' + order);
    }
    return e;
};

FPV.quatFromEuler = function (e, order) {
    const X = FPV.qAxisAngle({ x: 1, y: 0, z: 0 }, e.x);
    const Y = FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, e.y);
    const Z = FPV.qAxisAngle({ x: 0, y: 0, z: 1 }, e.z);
    const map = { X: X, Y: Y, Z: Z };
    return FPV.qNorm(FPV.qMul(FPV.qMul(map[order[0]], map[order[1]]), map[order[2]]));
};

// ---- JC3 camera conversion -------------------------------------------------
// JC3MP exposes camera.rotation as a Vector3f of euler angles (x = pitch,
// y = yaw, z = roll). Existing freecam packages show that positive yaw turns
// right and negative pitch looks up, i.e. the engine angles are the negation
// of right-handed angles. Order/signs are configurable (and flippable in the
// in-game settings panel) in case a game build disagrees.

FPV.toGameEuler = function (q, cam) {
    const e = FPV.eulerFromQuat(q, cam.eulerOrder);
    return { x: e.x * cam.pitchSign, y: e.y * cam.yawSign, z: e.z * cam.rollSign };
};

FPV.fromGameYaw = function (gameYaw, cam) {
    return FPV.qAxisAngle({ x: 0, y: 1, z: 0 }, gameYaw * cam.yawSign);
};

FPV.wrapAngle = function (a) {
    while (a > Math.PI) { a -= 2 * Math.PI; }
    while (a < -Math.PI) { a += 2 * Math.PI; }
    return a;
};
