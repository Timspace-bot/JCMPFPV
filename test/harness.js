// A minimal fake of the JC3MP scripting runtime (server + N clients) so the
// real package code can be exercised end to end in Node.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PKG = path.join(__dirname, '..', 'packages', 'fpvdrone');

class Vector3f {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    add(o) { return new Vector3f(this.x + o.x, this.y + o.y, this.z + o.z); }
    sub(o) { return new Vector3f(this.x - o.x, this.y - o.y, this.z - o.z); }
    get length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
}
class Vector2f { constructor(x, y) { this.x = x; this.y = y; } }
class Vector2 { constructor(x, y) { this.x = x; this.y = y; } }
class RGBA { constructor(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; } }
class Matrix {
    constructor(ops) { this.ops = ops || []; }
    Translate(v) { assertVec(v); return new Matrix(this.ops.concat([['T', v]])); }
    Rotate(a, v) { if (!isFinite(a)) { throw new Error('bad angle'); } assertVec(v); return new Matrix(this.ops.concat([['R', a, v]])); }
    Scale(v) { return new Matrix(this.ops.concat([['S', v]])); }
}
class Texture { constructor(p) { this.path = p; } }

function assertVec(v) {
    if (!(v instanceof Vector3f) || !isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) {
        throw new Error('expected finite Vector3f, got ' + JSON.stringify(v));
    }
}

function makeRenderer() {
    const r = { draws: 0, texts: 0, transforms: 0 };
    r.SetTransform = (m) => { if (!(m instanceof Matrix)) { throw new Error('SetTransform needs Matrix'); } r.transforms++; };
    r.DrawTexture = (t, p, s) => { if (!(t instanceof Texture)) { throw new Error('bad texture'); } assertVec(p); r.draws++; };
    r.DrawText = (txt, p, max, col, size, font) => { assertVec(p); r.texts++; };
    r.MeasureText = (t, size) => new Vector2f(t.length * size * 0.5, size);
    r.WorldToScreen = (p) => { assertVec(p); return new Vector2f(960, 540); };
    return r;
}

function Server() {
    this.clock = { t: 1000000 };
    this.players = [];
    this.clients = {};
    this.events = {};
    this.remote = {};
    this.log = [];
    const self = this;
    const jcmp = {
        players: this.players,
        events: {
            Add: (n, fn) => { (self.events[n] = self.events[n] || []).push(fn); },
            Call: (n, ...a) => (self.events[n] || []).map((fn) => fn(...a)),
            AddRemoteCallable: (n, fn) => { self.remote[n] = fn; },
            CallRemote: (n, target, ...a) => {
                const targets = target ? [target] : self.players;
                for (const p of targets) {
                    const c = self.clients[p.networkId];
                    if (c) { c.deliver(n, a); }
                }
            }
        }
    };
    const ctx = vm.createContext({
        jcmp: jcmp, Vector3f: Vector3f, console: { log: (m) => self.log.push(m) },
        Date: { now: () => self.clock.t }, Math: Math, JSON: JSON, Map: Map,
        require: (p) => { if (p === './config.js') { return self.config; } throw new Error('require ' + p); }
    });
    this.config = require(path.join(PKG, 'config.js'));
    this.config = JSON.parse(JSON.stringify(this.config));
    vm.runInContext(fs.readFileSync(path.join(PKG, 'main.js'), 'utf8'), ctx, { filename: 'server/main.js' });
}

Server.prototype.fromClient = function (player, name, args) {
    const fn = this.remote[name];
    if (!fn) { throw new Error('server has no remote callable ' + name); }
    fn(player, ...args);
};

Server.prototype.connect = function (name) {
    const id = this.players.length + 1;
    const player = {
        networkId: id, name: name, dimension: 0, invulnerable: false, vehicle: null, health: 800,
        position: new Vector3f(3400 + id * 10, 1050, 1300)
    };
    this.players.push(player);
    const client = new Client(this, player);
    this.clients[id] = client;
    (this.events.PlayerReady || []).forEach((fn) => fn(player));
    return client;
};

function Client(server, player) {
    this.server = server;
    this.player = player;
    this.events = {};
    this.remote = {};
    this.uiHandlers = {};
    this.uiCalls = [];
    this.errors = [];
    const self = this;
    const lp = {
        networkId: player.networkId,
        get position() { return new Vector3f(player.position.x, player.position.y, player.position.z); },
        camera: { position: new Vector3f(player.position.x, player.position.y + 2, player.position.z + 4),
            rotation: new Vector3f(0, 0.5, 0), attachedToPlayer: true, fieldOfView: 1.0 },
        frozen: false,
        controlsEnabled: true,
        lookAt: new Vector3f(0, 0, 0)
    };
    this.lp = lp;
    const jcmp = {
        localPlayer: lp,
        viewportSize: new Vector2(1920, 1080),
        print: (m) => { self.errors.push(m); },
        events: {
            Add: (n, fn) => { (self.events[n] = self.events[n] || []).push(fn); },
            Call: (n, ...a) => (self.events[n] || []).map((fn) => fn(...a)),
            AddRemoteCallable: (n, fn) => { self.remote[n] = fn; },
            CallRemote: (n, ...a) => { server.fromClient(player, n, a); }
        },
        ui: {
            AddEvent: (n, fn) => { self.uiHandlers[n] = fn; },
            CallEvent: (n, ...a) => { self.uiCalls.push([n].concat(a)); },
            HideHud: () => { self.hud = false; },
            ShowHud: () => { self.hud = true; }
        }
    };
    function WebUIWindow(name, url, size) { this.name = name; this.url = url; this.hidden = false; }
    const ctx = vm.createContext({
        jcmp: jcmp, Vector3f: Vector3f, Vector2f: Vector2f, Vector2: Vector2, RGBA: RGBA, Matrix: Matrix,
        Texture: Texture, WebUIWindow: WebUIWindow, Math: Math, JSON: JSON, Object: Object,
        Date: { now: () => server.clock.t }
    });
    vm.runInContext(fs.readFileSync(path.join(PKG, 'client_package', 'main.js'), 'utf8'), ctx, { filename: 'client/main.js' });
}

Client.prototype.deliver = function (name, args) {
    const fn = this.remote[name];
    if (!fn) { throw new Error('client has no remote callable ' + name); }
    fn(...args);
};

// Simulate the CEF page calling jcmp.CallEvent(name, ...args).
Client.prototype.ui = function (name, ...args) {
    const fn = this.uiHandlers[name];
    if (!fn) { throw new Error('client has no ui handler ' + name); }
    fn(...args);
};

Client.prototype.frame = function () {
    const r = makeRenderer();
    (this.events.GameUpdateRender || []).forEach((fn) => fn(r));
    (this.events.Render || []).forEach((fn) => fn(r));
    return r;
};

Client.prototype.lastUi = function (name) {
    for (let i = this.uiCalls.length - 1; i >= 0; i--) {
        if (this.uiCalls[i][0] === name) { return this.uiCalls[i].slice(1); }
    }
    return null;
};

// Advance every client by `seconds` at `fps`.
Server.prototype.run = function (seconds, fps) {
    fps = fps || 60;
    const n = Math.round(seconds * fps);
    let last = {};
    for (let i = 0; i < n; i++) {
        this.clock.t += 1000 / fps;
        for (const id in this.clients) { last[id] = this.clients[id].frame(); }
    }
    return last;
};

module.exports = { Server: Server, Vector3f: Vector3f };
