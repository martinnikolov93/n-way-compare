const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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

const chokidar = require('chokidar');
let folderWatcher = null;

// функция за watch
function watchFolders(folders) {
    // спираме стария watcher
    if (folderWatcher) folderWatcher.close();

    // нов watcher
    folderWatcher = chokidar.watch(folders, {
        ignoreInitial: true, // не стартираме при инициализация
        persistent: true,
        depth: 99
    });

    // дебаунс
    let scanTimeout = null;
    const triggerScan = () => {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
            scanTimeout = null;
            // уведомяваме renderer
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('folder-changed');
            });
        }, 500); // 0.5s delay
    };

    folderWatcher.on('all', (event, path) => {
        console.log('Folder change detected:', event, path);
        triggerScan();
    });
}

// IPC за стартиране на watch
ipcMain.handle('watch-folders', async (e, folders) => {
    watchFolders(folders);
});

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
                        hash: getSmartHash(full)
                    };
                }
            });
        }
        walk(dir);
    });

    return map;
}

ipcMain.handle('load-config', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled) return null;

    const filePath = result.filePaths[0];

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Config load error:', err);
        throw err;
    }
});

ipcMain.handle('save-config', async (e, data) => {
    const { dialog } = require('electron');

    const result = await dialog.showSaveDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled) return;

    try {
        fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
        return { success: true };
    } catch (err) {
        console.error('Save error:', err);
        throw err;
    }
});

ipcMain.handle('run-command', async (e, { dirs, command }) => {
    const { spawn } = require('child_process');

    try {
        dirs.forEach(dir => {
            // стартира cmd в тази папка
            spawn('cmd.exe', ['/c', command], {
                cwd: dir,
                detached: true,
                stdio: 'ignore',
                shell: true
            });
        });

        return { success: true };
    } catch (err) {
        console.error('CMD error:', err);
        throw err;
    }
});

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

ipcMain.handle('copy-file', async (e, { src, targets }) => {
    const fs = require('fs');
    const path = require('path');

    try {
        targets.forEach(target => {
            // създаваме директорията ако липсва
            const dir = path.dirname(target);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // копираме файла
            fs.copyFileSync(src, target);
        });

        return { success: true };
    } catch (err) {
        console.error('Copy error:', err);
        throw err;
    }
});

ipcMain.handle('delete-file', async (e, filePath) => {
    const fs = require('fs');

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return { success: true };
    } catch (err) {
        console.error('Delete error:', err);
        throw err;
    }
});

ipcMain.handle('copy-folder', async (e, { src, targets }) => {
    const fs = require('fs');
    const path = require('path');

    function copyRecursive(srcDir, destDir) {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        fs.readdirSync(srcDir, { withFileTypes: true }).forEach(entry => {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);

            if (entry.isDirectory()) {
                copyRecursive(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        });
    }

    try {
        targets.forEach(target => {
            copyRecursive(src, target);
        });

        return { success: true };
    } catch (err) {
        console.error('Folder copy error:', err);
        throw err;
    }
});

ipcMain.handle('delete-folder', async (e, folderPath) => {
    const fs = require('fs');
    const path = require('path');

    function deleteRecursive(dir) {
        if (!fs.existsSync(dir)) return;

        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                deleteRecursive(fullPath);
            } else {
                fs.unlinkSync(fullPath);
            }
        });

        fs.rmdirSync(dir);
    }

    try {
        deleteRecursive(folderPath);
        return { success: true };
    } catch (err) {
        console.error('Folder delete error:', err);
        throw err;
    }
});

function normalizeContent(buffer) {
    return buffer
        .toString('utf8')
        .replace(/\r\n/g, '\n') // CRLF → LF
        .trim();                // маха trailing whitespace
}

function getFileHash(filePath) {
    try {
        const data = fs.readFileSync(filePath);

        const normalized = normalizeContent(data);

        return crypto
            .createHash('md5')
            .update(normalized)
            .digest('hex');
    } catch (e) {
        return null;
    }
}

const hashCache = new Map();

function getSmartHash(filePath) {
    const stat = fs.statSync(filePath);
    const key = stat.size + '_' + stat.mtimeMs;

    // ✅ ако вече сме го смятали → връщаме кеша
    if (hashCache.has(filePath) && hashCache.get(filePath).key === key) {
        return hashCache.get(filePath).hash;
    }

    // ❗ само ако има промяна → правим hash
    const hash = getFileHash(filePath);

    hashCache.set(filePath, { key, hash });

    return hash;
}