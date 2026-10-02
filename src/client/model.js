// ---------------------------------------------------------------------------
// model.js - low-poly 3D models drawn with textured quads: the 5" quad and the
// radio Rico holds. JC3MP has no mesh API, so each model is a list of boxes,
// discs and planes; every face becomes one DrawTexture call under its own
// transform. Shading is baked into the textures (lighter tops, darker sides).
//
// Geometry is pure data (testable); drawing needs the game's Matrix/renderer.
// Body frame: +X right, +Y up, -Z forward. Units are metres.
// ---------------------------------------------------------------------------

FPV.MODEL_SCALE = 1.3;   // slightly larger than life so it reads at a distance

// 5" freestyle quad: stretched-X carbon frame, red anodised motors, LiPo on top.
FPV.QUAD_PARTS = (function () {
    const parts = [];
    const motors = [[-0.085, -0.074, 1], [0.085, -0.074, -1], [-0.085, 0.074, -1], [0.085, 0.074, 1]];
    const T = { top: 'carbon_top', side: 'carbon_side', bottom: 'carbon_bottom' };

    // Bottom + top plates, standoffs between them.
    parts.push({ box: [0, 0, 0], half: [0.03, 0.003, 0.058], tex: T });
    parts.push({ box: [0, 0.031, 0.004], half: [0.024, 0.002, 0.045], tex: T });
    [[-0.018, -0.035], [0.018, -0.035], [-0.018, 0.035], [0.018, 0.035]].forEach(function (s) {
        parts.push({ box: [s[0], 0.016, s[1]], half: [0.002, 0.013, 0.002], detail: true, tex: { top: 'accent', side: 'accent', bottom: 'accent' } });
    });
    // Arms (rotated about Y towards each motor) and motors with props.
    motors.forEach(function (m) {
        const len = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
        const yaw = Math.atan2(-m[0], -m[1]);   // rotation taking -Z onto the arm direction
        parts.push({ box: [m[0] / 2, 0, m[1] / 2], half: [0.008, 0.0028, len / 2 + 0.01], rotY: yaw, tex: T });
        parts.push({ box: [m[0], 0.014, m[1]], half: [0.0135, 0.011, 0.0135],
            tex: { top: 'motor_top', side: 'motor_side', bottom: 'carbon_bottom' } });
        parts.push({ disc: [m[0], 0.03, m[1]], radius: 0.0635, spin: m[2], prop: true });
    });
    // LiPo + strap.
    parts.push({ box: [0, 0.05, 0.006], half: [0.018, 0.016, 0.038],
        tex: { top: 'battery_top', side: 'battery_side', bottom: 'carbon_bottom', front: 'battery_end', back: 'battery_end' } });
    parts.push({ box: [0, 0.067, 0.006], half: [0.019, 0.0015, 0.007], detail: true, tex: { top: 'accent', side: 'accent', bottom: 'accent' } });
    // FPV camera in the front cage, tilted up.
    parts.push({ box: [0, 0.016, -0.058], half: [0.0105, 0.0105, 0.0105], tiltCam: true,
        tex: { top: 'cam_side', side: 'cam_side', bottom: 'cam_side', front: 'cam_front', back: 'cam_side' } });
    // VTX antenna at the back.
    parts.push({ plane: [0, 0.055, 0.06], size: [0.008, 0.06], detail: true, tex: 'antenna' });
    parts.push({ plane: [0, 0.055, 0.06], size: [0.008, 0.06], rotY: Math.PI / 2, detail: true, tex: 'antenna' });
    return parts;
})();

// Radio transmitter, in the hand-attach bone frame. The bone's axes are not
// documented, so the offset/rotation are kept here to tweak in one place.
FPV.TX_OFFSET = [0.0, 0.02, 0.06];
FPV.TX_ROT = [0, 0, 0];
FPV.TX_PARTS = [
    { box: [0, 0, 0], half: [0.085, 0.055, 0.022],
        tex: { top: 'radio_top', side: 'radio_side', bottom: 'radio_side', front: 'radio_face', back: 'radio_side' } },
    { box: [-0.04, 0.0, -0.03], half: [0.004, 0.004, 0.01], tex: { top: 'radio_side', side: 'radio_side', bottom: 'radio_side' } },
    { box: [0.04, 0.0, -0.03], half: [0.004, 0.004, 0.01], tex: { top: 'radio_side', side: 'radio_side', bottom: 'radio_side' } },
    { plane: [0.07, 0.09, 0.0], size: [0.008, 0.07], tex: 'antenna' },
    { plane: [0.07, 0.09, 0.0], size: [0.008, 0.07], rotY: Math.PI / 2, tex: 'antenna' }
];

// Expand parts into faces. Each face is a list of local transform ops applied
// after the model's base transform, plus a rectangle drawn in the face's XY
// plane (DrawTexture draws in the transform's XY plane).
//   op: ['T', x, y, z] translate | ['R', angle, ax, ay, az] rotate
FPV.buildFaces = function (parts, opts) {
    opts = opts || {};
    const faces = [];
    const H = Math.PI / 2;
    parts.forEach(function (p) {
        if (p.box) {
            const pre = [['T', p.box[0], p.box[1], p.box[2]]];
            if (p.rotY) { pre.push(['R', p.rotY, 0, 1, 0]); }
            if (p.tiltCam && opts.camTilt) { pre.push(['R', opts.camTilt, 1, 0, 0]); }
            const hx = p.half[0], hy = p.half[1], hz = p.half[2];
            const t = p.tex;
            const sides = [
                // [offset, rotation, width, height, texture]
                [[0, hy, 0], ['R', -H, 1, 0, 0], 2 * hx, 2 * hz, t.top],
                [[0, -hy, 0], ['R', H, 1, 0, 0], 2 * hx, 2 * hz, t.bottom],
                [[0, 0, hz], null, 2 * hx, 2 * hy, t.back || t.side],
                [[0, 0, -hz], ['R', Math.PI, 0, 1, 0], 2 * hx, 2 * hy, t.front || t.side],
                [[hx, 0, 0], ['R', H, 0, 1, 0], 2 * hz, 2 * hy, t.side],
                [[-hx, 0, 0], ['R', -H, 0, 1, 0], 2 * hz, 2 * hy, t.side]
            ];
            sides.forEach(function (s) {
                const ops = pre.slice();
                ops.push(['T', s[0][0], s[0][1], s[0][2]]);
                if (s[1]) { ops.push(s[1]); }
                faces.push({ ops: ops, w: s[2], h: s[3], tex: s[4], detail: !!p.detail });
            });
        } else if (p.disc) {
            faces.push({ ops: [['T', p.disc[0], p.disc[1], p.disc[2]], ['R', -H, 1, 0, 0]],
                w: 2 * p.radius, h: 2 * p.radius, tex: 'prop', prop: true, spin: p.spin });
        } else if (p.plane) {
            const ops = [['T', p.plane[0], p.plane[1], p.plane[2]]];
            if (p.rotY) { ops.push(['R', p.rotY, 0, 1, 0]); }
            faces.push({ ops: ops, w: p.size[0], h: p.size[1], tex: p.tex, detail: !!p.detail });
        }
    });
    return faces;
};

// ---- drawing (game API) ----------------------------------------------------

FPV.TEXTURES = ['carbon_top', 'carbon_side', 'carbon_bottom', 'accent', 'motor_top', 'motor_side',
    'battery_top', 'battery_side', 'battery_end', 'cam_front', 'cam_side', 'antenna',
    'prop_blur', 'prop_still', 'radio_face', 'radio_side', 'radio_top'];

FPV.ModelRenderer = function () {
    this.tex = {};
    this.ready = false;
    this.quadFaces = null;
    this.quadTilt = null;
    this.txFaces = FPV.buildFaces(FPV.TX_PARTS);
    this.zero = { x: 0, y: 0, z: 0 };
    try {
        for (let i = 0; i < FPV.TEXTURES.length; i++) {
            const n = FPV.TEXTURES[i];
            this.tex[n] = new Texture('package://fpvdrone/textures/' + n + '.png');
        }
        this.ready = true;
    } catch (e) {
        if (typeof jcmp.print === 'function') { jcmp.print('[fpvdrone] could not load model textures: ' + e); }
    }
};

FPV.ModelRenderer.prototype.facesFor = function (camTiltDeg) {
    if (!this.quadFaces || this.quadTilt !== camTiltDeg) {
        this.quadFaces = FPV.buildFaces(FPV.QUAD_PARTS, { camTilt: camTiltDeg * FPV.DEG });
        this.quadTilt = camTiltDeg;
    }
    return this.quadFaces;
};

function applyOps(m, ops) {
    for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        m = o[0] === 'T' ? m.Translate(new Vector3f(o[1], o[2], o[3])) : m.Rotate(o[1], new Vector3f(o[2], o[3], o[4]));
    }
    return m;
}

// Draw `faces` under the transform produced by baseFn() (called per face so
// we never rely on Matrix ops being non-mutating).
FPV.ModelRenderer.prototype.drawFaces = function (r, faces, baseFn, propAngle, armed, lod) {
    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        if (lod && (f.detail || Math.min(f.w, f.h) < 0.012)) { continue; }   // skip small details far away
        let m = applyOps(baseFn(), f.ops);
        let tex = this.tex[f.tex];
        if (f.prop) {
            m = m.Rotate(propAngle * f.spin, new Vector3f(0, 0, 1));
            tex = armed ? this.tex.prop_blur : this.tex.prop_still;
        }
        if (!tex) { continue; }
        r.SetTransform(m);
        r.DrawTexture(tex, new Vector3f(-f.w / 2, -f.h / 2, 0), new Vector2f(f.w, f.h));
    }
};

// poses: [{pos, q, armed}] ; time in seconds (prop spin)
FPV.ModelRenderer.prototype.drawQuads = function (r, poses, camPos, modelRotSign, camTiltDeg, time) {
    if (!this.ready || !poses.length) { return; }
    const faces = this.facesFor(camTiltDeg);
    const s = FPV.MODEL_SCALE;
    const scale = new Vector3f(s, s, s);
    if (typeof r.EnableCulling === 'function') { r.EnableCulling(false); }
    for (let i = 0; i < poses.length; i++) {
        const p = poses[i];
        const d = FPV.dist(p.pos, camPos);
        if (d > 1200 || d < 0.25) { continue; }
        const aa = FPV.qToAxisAngle(p.q);
        const pos = new Vector3f(p.pos.x, p.pos.y, p.pos.z);
        const axis = new Vector3f(aa.axis.x, aa.axis.y, aa.axis.z);
        const angle = aa.angle * modelRotSign;
        const base = function () { return new Matrix().Translate(pos).Rotate(angle, axis).Scale(scale); };
        const propAngle = p.armed ? time * 40 : 0.4;
        this.drawFaces(r, faces, base, propAngle, p.armed, d > 40);
    }
};

// Radio in a character's right hand. getBone() returns the hand-attach matrix.
FPV.ModelRenderer.prototype.drawRadio = function (r, getBone) {
    if (!this.ready) { return; }
    const off = new Vector3f(FPV.TX_OFFSET[0], FPV.TX_OFFSET[1], FPV.TX_OFFSET[2]);
    const rot = FPV.TX_ROT;
    const base = function () {
        let m = getBone().Translate(off);
        if (rot[0]) { m = m.Rotate(rot[0], new Vector3f(1, 0, 0)); }
        if (rot[1]) { m = m.Rotate(rot[1], new Vector3f(0, 1, 0)); }
        if (rot[2]) { m = m.Rotate(rot[2], new Vector3f(0, 0, 1)); }
        return m;
    };
    if (typeof r.EnableCulling === 'function') { r.EnableCulling(false); }
    this.drawFaces(r, this.txFaces, base, 0, false, false);
};
