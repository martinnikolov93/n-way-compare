const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

let mainWindow = null;
let updatePromptOpen = false;
let updateDownloadInProgress = false;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'assets', 'app-icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.loadFile('index.html');
    mainWindow = win;

    win.on('closed', () => {
        if (mainWindow === win) {
            mainWindow = null;
        }
    });
}

function getUpdateDialogWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function showUpdateMessage(options) {
    const ownerWindow = getUpdateDialogWindow();
    return ownerWindow
        ? dialog.showMessageBox(ownerWindow, options)
        : dialog.showMessageBox(options);
}

function formatUpdateVersion(info = {}) {
    return info.version ? `v${info.version}` : 'the latest version';
}

function setUpdateProgress(value) {
    const ownerWindow = getUpdateDialogWindow();

    if (ownerWindow) {
        ownerWindow.setProgressBar(value);
    }
}

function configureAutoUpdater() {
    if (!app.isPackaged) {
        return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', async info => {
        if (updatePromptOpen || updateDownloadInProgress) {
            return;
        }

        updatePromptOpen = true;

        try {
            const result = await showUpdateMessage({
                type: 'info',
                buttons: ['Update now', 'Later'],
                defaultId: 0,
                cancelId: 1,
                title: 'Update available',
                message: `N-Way Compare ${formatUpdateVersion(info)} is available.`,
                detail: `You are currently using v${app.getVersion()}.\n\nIf you update now, the app will download the latest installer and restart to complete the update.`
            });

            if (result.response !== 0) {
                return;
            }

            updateDownloadInProgress = true;
            setUpdateProgress(2);
            autoUpdater.downloadUpdate();
        } finally {
            updatePromptOpen = false;
        }
    });

    autoUpdater.on('download-progress', progress => {
        if (typeof progress?.percent === 'number') {
            setUpdateProgress(Math.max(0, Math.min(1, progress.percent / 100)));
        }
    });

    autoUpdater.on('update-downloaded', () => {
        updateDownloadInProgress = false;
        setUpdateProgress(-1);
        autoUpdater.quitAndInstall(false, true);
    });

    autoUpdater.on('error', async err => {
        const shouldNotify = updateDownloadInProgress;
        updateDownloadInProgress = false;
        setUpdateProgress(-1);

        if (!shouldNotify) {
            console.error('Update check failed:', err);
            return;
        }

        await showUpdateMessage({
            type: 'error',
            buttons: ['OK'],
            title: 'Update failed',
            message: 'N-Way Compare could not complete the update.',
            detail: err?.message || String(err)
        });
    });

    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error('Update check failed:', err);
        });
    }, 1500);
}

app.whenReady().then(() => {
    createWindow();
    configureAutoUpdater();
});

const chokidar = require('chokidar');
let folderWatcher = null;
let activeScanState = null;
const WATCH_DEBOUNCE_MS = 120;
const WATCH_MAX_WAIT_MS = 700;

function getDirsSignature(baseDirs) {
    return baseDirs.map(dir => path.resolve(dir)).join('||');
}

function createScanState(baseDirs) {
    const resolvedDirs = baseDirs.map(dir => path.resolve(dir));

    return {
        signature: getDirsSignature(resolvedDirs),
        baseDirs: resolvedDirs,
        map: {},
        entriesByDir: resolvedDirs.map(() => new Map()),
        dirtyRootsByDir: resolvedDirs.map(() => new Set([''])),
        initialized: false
    };
}

function normalizeRelativePath(relativePath) {
    if (!relativePath || relativePath === '.') {
        return '';
    }

    return path.normalize(relativePath);
}

function isSameOrDescendantPath(candidate, root) {
    if (!root) {
        return true;
    }

    return candidate === root || candidate.startsWith(root + path.sep);
}

function markStateDirty(state, dirIndex, relativePath = '') {
    const dirtyRoots = state?.dirtyRootsByDir?.[dirIndex];
    if (!dirtyRoots) {
        return;
    }

    const normalizedPath = normalizeRelativePath(relativePath);

    if (!normalizedPath) {
        dirtyRoots.clear();
        dirtyRoots.add('');
        return;
    }

    if (dirtyRoots.has('')) {
        return;
    }

    const descendantsToRemove = [];

    for (const dirtyRoot of dirtyRoots) {
        if (isSameOrDescendantPath(normalizedPath, dirtyRoot)) {
            return;
        }

        if (isSameOrDescendantPath(dirtyRoot, normalizedPath)) {
            descendantsToRemove.push(dirtyRoot);
        }
    }

    descendantsToRemove.forEach(dirtyRoot => dirtyRoots.delete(dirtyRoot));
    dirtyRoots.add(normalizedPath);
}

function markPathDirty(fullPath) {
    if (!activeScanState || !fullPath) {
        return;
    }

    const resolvedPath = path.resolve(fullPath);

    activeScanState.baseDirs.forEach((baseDir, dirIndex) => {
        const relativePath = path.relative(baseDir, resolvedPath);

        if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
            markStateDirty(activeScanState, dirIndex, relativePath);
        }
    });
}

function markPathsDirty(pathsToMark) {
    pathsToMark.forEach(fullPath => markPathDirty(fullPath));
}

function getWatcherIgnoreReason(event, changedPath, watchedFolders) {
    if (!changedPath) {
        return 'missing-path';
    }

    const resolvedPath = path.resolve(changedPath);
    const resolvedRoots = watchedFolders.map(folder => path.resolve(folder));

    if (event === 'change') {
        if (resolvedRoots.includes(resolvedPath)) {
            return 'root-directory-change';
        }

        try {
            if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
                return 'directory-metadata-change';
            }
        } catch {
            // If the path disappeared between events, let the scan path handle it.
        }
    }

    return null;
}

function shouldIgnoreWatcherEvent(event, changedPath, watchedFolders) {
    return Boolean(getWatcherIgnoreReason(event, changedPath, watchedFolders));
}

function setStateEntry(state, dirIndex, relativePath, entry) {
    state.entriesByDir[dirIndex].set(relativePath, entry);

    if (!state.map[relativePath]) {
        state.map[relativePath] = {};
    }

    state.map[relativePath][dirIndex] = entry;
}

function removeStateEntry(state, dirIndex, relativePath) {
    state.entriesByDir[dirIndex].delete(relativePath);

    const mapEntry = state.map[relativePath];
    if (!mapEntry) {
        return;
    }

    delete mapEntry[dirIndex];

    if (!Object.keys(mapEntry).length) {
        delete state.map[relativePath];
    }
}

// С„СѓРЅРєС†РёСЏ Р·Р° watch
function watchFolders(folders) {
    if (folderWatcher) {
        folderWatcher.close();
    }

    folderWatcher = chokidar.watch(folders, {
        ignoreInitial: true,
        persistent: true,
        depth: 99
    });

    let scanTimeout = null;
    let burstStartedAt = 0;

    const flushScan = () => {
        if (scanTimeout) {
            clearTimeout(scanTimeout);
            scanTimeout = null;
        }

        burstStartedAt = 0;

        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('folder-changed');
        });
    };

    const triggerScan = () => {
        const now = Date.now();

        if (!burstStartedAt) {
            burstStartedAt = now;
        }

        if (scanTimeout) {
            clearTimeout(scanTimeout);
        }

        const elapsed = now - burstStartedAt;
        const remainingMaxWait = Math.max(0, WATCH_MAX_WAIT_MS - elapsed);
        const delay = Math.min(WATCH_DEBOUNCE_MS, remainingMaxWait);

        scanTimeout = setTimeout(() => {
            flushScan();
        }, delay);
    };

    folderWatcher.on('all', (event, changedPath) => {
        const ignoreReason = getWatcherIgnoreReason(event, changedPath, folders);

        if (ignoreReason) {
            return;
        }

        markPathDirty(changedPath);

        triggerScan();
    });
}

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

function collectDirectoryEntries(state, dirIndex, currentDir, rel = '', options = {}) {
    const { suppressErrors = false, impactedFiles = null, impactedPaths = null } = options;
    let dirEntries;

    try {
        dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
        if (suppressErrors) {
            return;
        }

        throw err;
    }

    dirEntries.forEach(entry => {
        const full = path.join(currentDir, entry.name);
        const relative = rel ? path.join(rel, entry.name) : entry.name;

        if (entry.isDirectory()) {
            setStateEntry(state, dirIndex, relative, {
                path: full,
                isDir: true
            });

            if (impactedPaths) {
                impactedPaths.add(relative);
            }

            collectDirectoryEntries(state, dirIndex, full, relative, {
                suppressErrors,
                impactedFiles,
                impactedPaths
            });
            return;
        }

        const fileEntry = {
            path: full,
            isDir: false,
            hash: null
        };

        setStateEntry(state, dirIndex, relative, fileEntry);

        if (impactedFiles) {
            impactedFiles.add(relative);
        }

        if (impactedPaths) {
            impactedPaths.add(relative);
        }
    });
}

function removeEntriesUnderRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths, fullPath = null) {
    const normalizedRoot = normalizeRelativePath(relativeRoot);

    if (normalizedRoot) {
        const directEntry = state.entriesByDir[dirIndex].get(normalizedRoot);

        if (directEntry && !directEntry.isDir) {
            if (impactedPaths) {
                impactedPaths.add(normalizedRoot);
            }

            impactedFiles.add(normalizedRoot);
            hashCache.delete(directEntry.path);
            removeStateEntry(state, dirIndex, normalizedRoot);
            return;
        }

        if (!directEntry && fullPath) {
            try {
                const stat = fs.statSync(fullPath);

                if (stat.isFile()) {
                    if (impactedPaths) {
                        impactedPaths.add(normalizedRoot);
                    }

                    return;
                }
            } catch {
                // Fall back to the subtree walk for missing or unreadable paths.
            }
        }
    }

    const entries = Array.from(state.entriesByDir[dirIndex].entries());

    entries.forEach(([relativePath, entry]) => {
        if (!normalizedRoot || isSameOrDescendantPath(relativePath, normalizedRoot)) {
            if (impactedPaths) {
                impactedPaths.add(relativePath);
            }

            if (entry && !entry.isDir) {
                impactedFiles.add(relativePath);
                hashCache.delete(entry.path);
            }

            removeStateEntry(state, dirIndex, relativePath);
        }
    });
}

function scanExistingRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths) {
    const baseDir = state.baseDirs[dirIndex];
    const fullPath = relativeRoot ? path.join(baseDir, relativeRoot) : baseDir;

    if (!fs.existsSync(fullPath)) {
        return;
    }

    let stat;

    try {
        stat = fs.statSync(fullPath);
    } catch {
        return;
    }

    if (stat.isDirectory()) {
        if (relativeRoot) {
            setStateEntry(state, dirIndex, relativeRoot, {
                path: fullPath,
                isDir: true
            });

            if (impactedPaths) {
                impactedPaths.add(relativeRoot);
            }
        }

        collectDirectoryEntries(state, dirIndex, fullPath, relativeRoot, {
            suppressErrors: true,
            impactedFiles,
            impactedPaths
        });
        return;
    }

    const fileEntry = {
        path: fullPath,
        isDir: false,
        hash: null
    };

    setStateEntry(state, dirIndex, relativeRoot, fileEntry);
    impactedFiles.add(relativeRoot);

    if (impactedPaths) {
        impactedPaths.add(relativeRoot);
    }
}

function finalizeHashesForRelativePaths(state, relativePaths) {
    relativePaths.forEach(relativePath => {
        const mapEntry = state.map[relativePath];

        if (!mapEntry) {
            return;
        }

        const fileEntries = Object.values(mapEntry).filter(entry => entry && !entry.isDir);

        if (!fileEntries.length) {
            return;
        }

        if (fileEntries.length === 1) {
            fileEntries[0].hash = '__FILE_PRESENT__';
            return;
        }

        fileEntries.forEach(fileEntry => {
            fileEntry.hash = getSmartHash(fileEntry.path);
        });
    });
}

function hasPendingDirtyUpdates(state) {
    return state.dirtyRootsByDir.some(dirtyRoots => dirtyRoots.size > 0);
}

function buildIncrementalPayload(state, impactedPaths) {
    if (!impactedPaths.size) {
        return { mode: 'noop' };
    }

    const currentPathCount = Object.keys(state.map).length;
    if (impactedPaths.size > currentPathCount * 0.6) {
        return {
            mode: 'full',
            data: state.map
        };
    }

    const upserts = {};
    const removals = [];

    impactedPaths.forEach(relativePath => {
        if (state.map[relativePath]) {
            upserts[relativePath] = state.map[relativePath];
            return;
        }

        removals.push(relativePath);
    });

    if (!Object.keys(upserts).length && !removals.length) {
        return { mode: 'noop' };
    }

    return {
        mode: 'patch',
        upserts,
        removals
    };
}

function performFullScan(state) {
    state.map = {};
    state.entriesByDir = state.baseDirs.map(() => new Map());

    const impactedFiles = new Set();

    state.baseDirs.forEach((dir, dirIndex) => {
        collectDirectoryEntries(state, dirIndex, dir, '', {
            suppressErrors: false,
            impactedFiles
        });
    });

    finalizeHashesForRelativePaths(state, impactedFiles);
    state.dirtyRootsByDir = state.baseDirs.map(() => new Set());
    state.initialized = true;
}

function applyDirtyUpdates(state) {
    const impactedFiles = new Set();
    const impactedPaths = new Set();

    state.dirtyRootsByDir.forEach((dirtyRoots, dirIndex) => {
        if (!dirtyRoots.size) {
            return;
        }

        const rootsToRefresh = Array.from(dirtyRoots).sort((left, right) => left.length - right.length);
        dirtyRoots.clear();

        rootsToRefresh.forEach(relativeRoot => {
            const fullPath = relativeRoot ? path.join(state.baseDirs[dirIndex], relativeRoot) : state.baseDirs[dirIndex];
            removeEntriesUnderRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths, fullPath);
            scanExistingRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths);
        });
    });

    finalizeHashesForRelativePaths(state, impactedFiles);
    return buildIncrementalPayload(state, impactedPaths);
}

function scanDirs(baseDirs) {
    const signature = getDirsSignature(baseDirs);

    if (!activeScanState || activeScanState.signature !== signature) {
        activeScanState = createScanState(baseDirs);
    }

    if (!activeScanState.initialized) {
        performFullScan(activeScanState);
        return {
            mode: 'full',
            data: activeScanState.map
        };
    }

    if (!hasPendingDirtyUpdates(activeScanState)) {
        return {
            mode: 'noop'
        };
    }

    return applyDirtyUpdates(activeScanState);
}

function resolveDialogDefaultPath(inputPath = '') {
    if (!inputPath || typeof inputPath !== 'string') {
        return undefined;
    }

    let candidatePath = path.resolve(inputPath.trim());

    while (candidatePath && candidatePath !== path.dirname(candidatePath)) {
        if (fs.existsSync(candidatePath)) {
            try {
                return fs.statSync(candidatePath).isDirectory()
                    ? candidatePath
                    : path.dirname(candidatePath);
            } catch {
                return path.dirname(candidatePath);
            }
        }

        candidatePath = path.dirname(candidatePath);
    }

    if (candidatePath && fs.existsSync(candidatePath)) {
        return candidatePath;
    }

    return undefined;
}

ipcMain.handle('pick-folder', async (event, initialPath) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = resolveDialogDefaultPath(initialPath);
    const result = await dialog.showOpenDialog(browserWindow, {
        properties: ['openDirectory'],
        defaultPath
    });

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0] || null;
});

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
            // СЃС‚Р°СЂС‚РёСЂР° cmd РІ С‚Р°Р·Рё РїР°РїРєР°
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

ipcMain.handle('read-files', async (e, filePaths) => {
    return filePaths.map(filePath => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return {
                    path: filePath,
                    exists: false,
                    content: ''
                };
            }

            return {
                path: filePath,
                exists: true,
                content: fs.readFileSync(filePath, 'utf8')
            };
        } catch (err) {
            return {
                path: filePath,
                exists: false,
                content: '',
                error: err.message
            };
        }
    });
});

ipcMain.handle('write-file', async (e, { path: filePath, content }) => {
    try {
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');

        return {
            success: true,
            path: filePath
        };
    } catch (err) {
        console.error('Write error:', err);
        throw err;
    }
});

ipcMain.handle('copy-file', async (e, { src, targets }) => {
    const fs = require('fs');
    const path = require('path');

    try {
        targets.forEach(target => {
            // СЃСЉР·РґР°РІР°РјРµ РґРёСЂРµРєС‚РѕСЂРёСЏС‚Р° Р°РєРѕ Р»РёРїСЃРІР°
            const dir = path.dirname(target);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // РєРѕРїРёСЂР°РјРµ С„Р°Р№Р»Р°
            fs.copyFileSync(src, target);
        });

        markPathsDirty(targets);
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

        markPathDirty(filePath);
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

        markPathsDirty(targets);
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
        markPathDirty(folderPath);
        return { success: true };
    } catch (err) {
        console.error('Folder delete error:', err);
        throw err;
    }
});

function normalizeContent(buffer) {
    return buffer
        .toString('utf8')
        .replace(/\r\n/g, '\n') // CRLF в†’ LF
        .trim();                // РјР°С…Р° trailing whitespace
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

    // вњ… Р°РєРѕ РІРµС‡Рµ СЃРјРµ РіРѕ СЃРјСЏС‚Р°Р»Рё в†’ РІСЂСЉС‰Р°РјРµ РєРµС€Р°
    if (hashCache.has(filePath) && hashCache.get(filePath).key === key) {
        return hashCache.get(filePath).hash;
    }

    // вќ— СЃР°РјРѕ Р°РєРѕ РёРјР° РїСЂРѕРјСЏРЅР° в†’ РїСЂР°РІРёРј hash
    const hash = getFileHash(filePath);

    hashCache.set(filePath, { key, hash });

    return hash;
}
