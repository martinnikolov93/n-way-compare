const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

function hashFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.size + '-' + stat.mtimeMs; // faster than full hash
    } catch {
        return null;
    }
}

function scanDirs(baseDirs) {
    const map = {};

    baseDirs.forEach((dir, idx) => {
        function walk(current, rel = '') {
            fs.readdirSync(current, { withFileTypes: true }).forEach(entry => {
                const full = path.join(current, entry.name);
                const relative = path.join(rel, entry.name);

                if (entry.isDirectory()) {
                    walk(full, relative);
                } else {
                    if (!map[relative]) map[relative] = {};
                    map[relative][idx] = {
                        path: full,
                        hash: hashFile(full)
                    };
                }
            });
        }
        walk(dir);
    });

    return map;
}

ipcMain.handle('scan', async (e, dirs) => scanDirs(dirs));

ipcMain.handle('open-diffuse', async (e, files) => {
    // Windows-safe execution using spawn instead of exec
    const { spawn } = require('child_process');

    const args = files.map(f => f);

    const proc = spawn('diffuse', args, {
        detached: true,
        stdio: 'ignore',
        shell: true
    });

});