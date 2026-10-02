// Loads the pure client modules (math + physics) into a sandbox so they can be
// tested in Node without the game runtime.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'client');

function loadPure() {
    const ctx = vm.createContext({ Math: Math, JSON: JSON, Infinity: Infinity, isFinite: isFinite, FPV: {} });
    for (const f of ['math.js', 'physics.js', 'world.js', 'swarm.js', 'model.js']) {
        vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
    }
    return ctx.FPV;
}

module.exports = { loadPure: loadPure };
