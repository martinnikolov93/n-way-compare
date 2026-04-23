const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDifferenceEngine() {
    const engineCode = fs.readFileSync(path.join(__dirname, '..', '..', 'difference-engine.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);
    return sandbox.window.DifferenceEngine;
}

module.exports = {
    loadDifferenceEngine
};
