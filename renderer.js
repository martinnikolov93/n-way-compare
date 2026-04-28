let currentData = {};
let dirs = [];
let currentTree = null;
let currentDiffCache = new Map();
let currentStats = { folders: 0, files: 0, diffs: 0 };
let preservedScrollState = null;
let scrollRestoreToken = 0;
let activeRenderController = null;
let statsRefreshTimer = null;
let mainActionHistoryState = { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' };
let mainActionHistoryBusy = false;
let mainBatchActionBusy = false;
let appToastTimer = null;

const collapseState = {};
const comparisonSelections = new Map();
let lastWatchedDirs = [];
let lastWatchedExclusions = [];
let scanPromise = null;
let scanQueued = false;
let queuedResetCache = false;
let updateOverlay = null;
let scanOverlay = null;
let scanOverlayTimer = null;
let scanOverlayStepIndex = 0;
let diffuseAvailable = false;
let diffuseAvailabilityChecked = false;
let diffuseAvailabilityPromise = null;

const SCAN_OVERLAY_STEPS = Object.freeze([
    'Preparing folder scan',
    'Indexing folder contents',
    'Applying exclusion patterns',
    'Comparing file metadata',
    'Preparing comparison tree'
]);

async function ensureDiffuseAvailability() {
    if (diffuseAvailabilityChecked) {
        return diffuseAvailable;
    }

    if (diffuseAvailabilityPromise) {
        return diffuseAvailabilityPromise;
    }

    diffuseAvailabilityPromise = (async () => {
        try {
            diffuseAvailable = Boolean(await window.api.isDiffuseAvailable?.());
        } catch (err) {
            diffuseAvailable = false;
            console.warn('Could not detect Diffuse availability:', err);
        } finally {
            diffuseAvailabilityChecked = true;
            diffuseAvailabilityPromise = null;
        }

        if (currentTree) {
            render();
        }

        return diffuseAvailable;
    })();

    return diffuseAvailabilityPromise;
}

const COMPARE_LAYOUT = Object.freeze({
    nameWidth: 360,
    directoryWidth: 168,
    actionsWidth: 176
});

function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function syncMainActionHistoryState(nextState = {}) {
    mainActionHistoryState = {
        canUndo: Boolean(nextState.canUndo),
        canRedo: Boolean(nextState.canRedo),
        undoLabel: nextState.undoLabel || '',
        redoLabel: nextState.redoLabel || ''
    };

    activeRenderController?.refreshMainActionButtons?.();
}

async function refreshMainActionHistoryState() {
    if (!window.api.getMainActionHistoryState) {
        return;
    }

    try {
        syncMainActionHistoryState(await window.api.getMainActionHistoryState());
    } catch (err) {
        console.warn('Could not refresh action history state:', err);
    }
}

function showAppToast(message, tone = 'success') {
    let toast = document.getElementById('appToast');

    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'appToast';
        toast.className = 'app-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `app-toast is-${tone}`;

    if (appToastTimer) {
        clearTimeout(appToastTimer);
    }

    requestAnimationFrame(() => {
        toast.classList.add('is-visible');
    });

    appToastTimer = setTimeout(() => {
        toast.classList.remove('is-visible');
    }, 2400);
}

async function handleMainActionSuccess(result, message) {
    if (result?.history) {
        syncMainActionHistoryState(result.history);
    } else {
        await refreshMainActionHistoryState();
    }

    showAppToast(message);
}

async function performMainActionHistoryCommand(commandName, successMessage) {
    if (mainActionHistoryBusy || !window.api[commandName]) {
        return;
    }

    mainActionHistoryBusy = true;
    activeRenderController?.refreshMainActionButtons?.();

    try {
        const result = await window.api[commandName]();

        if (result?.history) {
            syncMainActionHistoryState(result.history);
        }

        if (!result?.success) {
            showAppToast(result?.message || 'Nothing to apply', 'neutral');
            return;
        }

        showAppToast(successMessage);
        scan();
    } catch (err) {
        alert('Action history error: ' + err.message);
    } finally {
        mainActionHistoryBusy = false;
        activeRenderController?.refreshMainActionButtons?.();
    }
}

function undoMainAction() {
    return performMainActionHistoryCommand('undoMainAction', 'Undo successful');
}

function redoMainAction() {
    return performMainActionHistoryCommand('redoMainAction', 'Redo successful');
}

function getComparisonSelectionKey(kind, relativePath = '') {
    return `${kind}:${normalizeDataPath(relativePath)}`;
}

function getComparisonSelection(kind, relativePath = '', create = false) {
    const normalizedPath = normalizeDataPath(relativePath);
    const key = getComparisonSelectionKey(kind, normalizedPath);

    if (!comparisonSelections.has(key) && create) {
        comparisonSelections.set(key, {
            kind,
            relativePath: normalizedPath,
            sourceIndex: null,
            targetIndexes: new Set()
        });
    }

    return comparisonSelections.get(key) || null;
}

function cleanupComparisonSelection(selection) {
    if (!selection) {
        return;
    }

    if (selection.sourceIndex === null && selection.targetIndexes.size === 0) {
        comparisonSelections.delete(getComparisonSelectionKey(selection.kind, selection.relativePath));
    }
}

function clearComparisonSelections() {
    comparisonSelections.clear();
    activeRenderController?.refreshSelectionControls?.();
}

function updateSelectionSource(kind, relativePath, dirIndex) {
    const selection = getComparisonSelection(kind, relativePath, true);
    selection.sourceIndex = dirIndex;
    cleanupComparisonSelection(selection);
    activeRenderController?.refreshMainActionButtons?.();
}

function updateSelectionTarget(kind, relativePath, dirIndex, checked) {
    const selection = getComparisonSelection(kind, relativePath, true);

    if (checked) {
        selection.targetIndexes.add(dirIndex);
    } else {
        selection.targetIndexes.delete(dirIndex);
    }

    cleanupComparisonSelection(selection);
    activeRenderController?.refreshMainActionButtons?.();
}

function getFolderNodeByRelativePath(relativePath = '') {
    const normalizedPath = normalizeDataPath(relativePath);
    if (!normalizedPath) {
        return currentTree;
    }

    return getTreeFolderNode(normalizedPath.split('/').filter(Boolean));
}

function getSelectionTargetPath(kind, relativePath, dirIndex) {
    const normalizedPath = normalizeDataPath(relativePath);

    if (kind === 'folder') {
        return normalizedPath ? buildFileTargetPath(dirs[dirIndex], normalizedPath) : dirs[dirIndex];
    }

    return currentData[normalizedPath]?.[dirIndex]?.path || buildFileTargetPath(dirs[dirIndex], normalizedPath);
}

function selectionExistsInDir(kind, relativePath, dirIndex) {
    const normalizedPath = normalizeDataPath(relativePath);

    if (kind === 'folder') {
        const node = getFolderNodeByRelativePath(normalizedPath);
        return Boolean(node && folderExistsInDir(dirIndex, node));
    }

    return Boolean(currentData[normalizedPath]?.[dirIndex]);
}

function getSelectionTitle(kind, relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);

    if (!normalizedPath) {
        return 'Workspace root';
    }

    return kind === 'folder'
        ? normalizedPath.split('/').pop()
        : getFileName(normalizedPath);
}

function isDescendantPath(candidatePath, parentPath) {
    const candidate = normalizeDataPath(candidatePath);
    const parent = normalizeDataPath(parentPath);

    if (!parent) {
        return Boolean(candidate);
    }

    return candidate.startsWith(`${parent}/`);
}

function getSelectedTargetIndexes(selection, mode) {
    return Array.from(selection.targetIndexes)
        .filter(index => index >= 0 && index < dirs.length)
        .filter(index => mode !== 'copy' || index !== selection.sourceIndex);
}

function createSelectionPreviewAction(selection, mode, targetIndexes) {
    const kind = selection.kind;
    const relativePath = selection.relativePath;
    const sourceIndex = selection.sourceIndex;
    const type = mode === 'copy'
        ? `copy-${kind}`
        : `delete-${kind}`;
    const sourcePath = mode === 'copy'
        ? getSelectionTargetPath(kind, relativePath, sourceIndex)
        : '';
    const targets = targetIndexes.map(index => getSelectionTargetPath(kind, relativePath, index));

    return {
        type,
        kind,
        relativePath,
        title: getSelectionTitle(kind, relativePath),
        src: sourcePath,
        targets,
        sourceIndex,
        targetIndexes,
        sourceLabel: sourceIndex === null ? '' : (getFolderName(dirs[sourceIndex]) || `Column ${sourceIndex + 1}`),
        targetLabels: targetIndexes.map(index => getFolderName(dirs[index]) || `Column ${index + 1}`),
        overwriteCount: mode === 'copy'
            ? targetIndexes.filter(index => selectionExistsInDir(kind, relativePath, index)).length
            : 0
    };
}

function pruneCoveredCopyTargets(items) {
    const folderSelections = items
        .filter(item => item.selection.kind === 'folder' && item.selection.sourceIndex !== null)
        .map(item => ({
            relativePath: item.selection.relativePath,
            sourceIndex: item.selection.sourceIndex,
            targetIndexes: new Set(item.targetIndexes)
        }));
    let prunedCount = 0;

    const nextItems = items
        .map(item => {
            if (!item.selection.relativePath) {
                return item;
            }

            const nextTargetIndexes = item.targetIndexes.filter(targetIndex => {
                const isCovered = folderSelections.some(folder => (
                    folder !== item &&
                    folder.sourceIndex === item.selection.sourceIndex &&
                    folder.targetIndexes.has(targetIndex) &&
                    isDescendantPath(item.selection.relativePath, folder.relativePath)
                ));

                if (isCovered) {
                    prunedCount += 1;
                }

                return !isCovered;
            });

            return { ...item, targetIndexes: nextTargetIndexes };
        })
        .filter(item => item.targetIndexes.length);

    return { items: nextItems, prunedCount };
}

function pruneCoveredDeleteTargets(items) {
    const folderTargets = items
        .filter(item => item.selection.kind === 'folder')
        .flatMap(item => item.targetIndexes.map(targetIndex => ({
            relativePath: item.selection.relativePath,
            targetIndex
        })));
    let prunedCount = 0;

    const nextItems = items
        .map(item => {
            if (!item.selection.relativePath) {
                return item;
            }

            const nextTargetIndexes = item.targetIndexes.filter(targetIndex => {
                const isCovered = folderTargets.some(folder => (
                    folder.targetIndex === targetIndex &&
                    isDescendantPath(item.selection.relativePath, folder.relativePath)
                ));

                if (isCovered) {
                    prunedCount += 1;
                }

                return !isCovered;
            });

            return { ...item, targetIndexes: nextTargetIndexes };
        })
        .filter(item => item.targetIndexes.length);

    return { items: nextItems, prunedCount };
}

function buildMainBatchPreview(mode) {
    const selectionItems = Array.from(comparisonSelections.values())
        .map(selection => {
            const targetIndexes = getSelectedTargetIndexes(selection, mode)
                .filter(index => mode === 'copy' || selectionExistsInDir(selection.kind, selection.relativePath, index));

            return { selection, targetIndexes };
        })
        .filter(item => item.targetIndexes.length)
        .filter(item => mode !== 'copy' || (
            item.selection.sourceIndex !== null &&
            selectionExistsInDir(item.selection.kind, item.selection.relativePath, item.selection.sourceIndex)
        ));

    const pruned = mode === 'copy'
        ? pruneCoveredCopyTargets(selectionItems)
        : pruneCoveredDeleteTargets(selectionItems);

    const actions = pruned.items.map(item => createSelectionPreviewAction(item.selection, mode, item.targetIndexes));
    const totalTargets = actions.reduce((total, action) => total + action.targets.length, 0);

    return {
        mode,
        actions,
        totalTargets,
        prunedCount: pruned.prunedCount
    };
}

function formatPreviewActionLine(action) {
    if (action.type.startsWith('copy-')) {
        const overwriteText = action.overwriteCount
            ? `, ${action.overwriteCount} overwrite${action.overwriteCount === 1 ? '' : 's'}`
            : '';
        return `${action.kind}: ${action.title} | ${action.sourceLabel} -> ${action.targetLabels.join(', ')}${overwriteText}`;
    }

    return `${action.kind}: ${action.title} | delete from ${action.targetLabels.join(', ')}`;
}

function showBatchActionPreview(preview) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'batch-action-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const card = document.createElement('div');
        card.className = 'batch-action-card';

        const eyebrow = document.createElement('div');
        eyebrow.className = 'batch-action-eyebrow';
        eyebrow.textContent = preview.mode === 'copy' ? 'Batch copy' : 'Batch delete';

        const title = document.createElement('h3');
        title.className = 'batch-action-title';
        title.textContent = preview.mode === 'copy'
            ? `Copy ${preview.totalTargets} selected target${preview.totalTargets === 1 ? '' : 's'}?`
            : `Delete ${preview.totalTargets} selected item${preview.totalTargets === 1 ? '' : 's'}?`;

        const note = document.createElement('p');
        note.className = 'batch-action-note';
        note.textContent = preview.prunedCount
            ? `${preview.prunedCount} nested selection${preview.prunedCount === 1 ? '' : 's'} will be skipped because a parent folder already covers them.`
            : 'Review the actions below before continuing.';

        const list = document.createElement('div');
        list.className = 'batch-action-list';

        preview.actions.slice(0, 18).forEach(action => {
            const item = document.createElement('div');
            item.className = 'batch-action-item';
            item.textContent = formatPreviewActionLine(action);
            item.title = item.textContent;
            list.appendChild(item);
        });

        if (preview.actions.length > 18) {
            const overflow = document.createElement('div');
            overflow.className = 'batch-action-overflow';
            overflow.textContent = `+ ${preview.actions.length - 18} more action${preview.actions.length - 18 === 1 ? '' : 's'}`;
            list.appendChild(overflow);
        }

        const actions = document.createElement('div');
        actions.className = 'batch-action-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'app-btn app-btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = `app-btn ${preview.mode === 'delete' ? 'app-btn-danger' : 'app-btn-primary'}`;
        confirmBtn.textContent = preview.mode === 'copy' ? 'Copy selected' : 'Delete selected';

        const close = result => {
            document.removeEventListener('keydown', handleKeyDown);
            overlay.remove();
            resolve(result);
        };

        const handleKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(false);
            }
        };

        cancelBtn.addEventListener('click', () => close(false));
        confirmBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                close(false);
            }
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        card.appendChild(eyebrow);
        card.appendChild(title);
        card.appendChild(note);
        card.appendChild(list);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', handleKeyDown);
        confirmBtn.focus();
    });
}

async function runGlobalMainBatchAction(mode) {
    if (mainBatchActionBusy || !window.api.runMainActions) {
        return;
    }

    const preview = buildMainBatchPreview(mode);

    if (!preview.actions.length) {
        showAppToast(
            mode === 'copy' ? 'Select a source and at least one target first' : 'Select existing targets first',
            'neutral'
        );
        return;
    }

    const confirmed = await showBatchActionPreview(preview);
    if (!confirmed) {
        return;
    }

    mainBatchActionBusy = true;
    activeRenderController?.refreshMainActionButtons?.();

    try {
        const result = await window.api.runMainActions(preview.actions);

        await handleMainActionSuccess(result, mode === 'copy' ? 'Copy successful' : 'Delete successful');
        clearComparisonSelections();
        activeRenderController?.refreshSelectionControls?.();
    } catch (err) {
        alert('Batch action error: ' + err.message);
    } finally {
        mainBatchActionBusy = false;
        activeRenderController?.refreshMainActionButtons?.();
    }
}

function getDirs() {
    const inputs = document.querySelectorAll('.folder-input');
    return Array.from(inputs).map(input => input.value.trim()).filter(Boolean);
}

function getExclusionPatterns() {
    const input = document.getElementById('exclusionInput');
    if (!input) {
        return [];
    }

    return input.value
        .split(/[\n,;]+/)
        .map(pattern => pattern.trim())
        .filter(Boolean);
}

function setExclusionPatterns(patterns = []) {
    const input = document.getElementById('exclusionInput');
    if (!input) {
        return;
    }

    input.value = Array.isArray(patterns)
        ? patterns.map(pattern => String(pattern).trim()).filter(Boolean).join('\n')
        : '';
}

function getFoldersContainer() {
    return document.getElementById('folders');
}

function refreshFolderInputPlaceholders() {
    const fields = Array.from(document.querySelectorAll('.folder-input-shell'));
    const canRemove = fields.length > 2;

    fields.forEach((field, index) => {
        const input = field.querySelector('.folder-input');
        const removeButton = field.querySelector('.folder-remove-btn');

        if (!input) {
            return;
        }

        input.placeholder = `Folder ${index + 1}`;

        if (removeButton) {
            removeButton.disabled = !canRemove;
            removeButton.title = canRemove ? 'Remove folder from comparison' : 'At least two folders are required';
            removeButton.setAttribute(
                'aria-label',
                canRemove ? `Remove folder ${index + 1}` : 'At least two folders are required'
            );
        }
    });
}

async function openFolderPickerForInput(input) {
    if (!input) {
        return;
    }

    try {
        const selectedPath = await window.api.pickFolder(input.value.trim());

        if (selectedPath) {
            input.value = selectedPath;
            input.title = selectedPath;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } catch (err) {
        alert('Folder picker error: ' + err.message);
    } finally {
        input.focus();
    }
}

function createFolderInputField(value = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-input-shell';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'folder-input';
    input.value = value;
    input.title = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => {
        input.title = input.value.trim();
    });

    const actions = document.createElement('div');
    actions.className = 'folder-input-actions';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'folder-remove-btn';
    removeButton.title = 'Remove folder from comparison';
    removeButton.setAttribute('aria-label', 'Remove folder from comparison');
    removeButton.textContent = 'x';
    removeButton.addEventListener('click', () => {
        const foldersContainer = getFoldersContainer();
        if (foldersContainer.children.length <= 2) {
            input.value = '';
            input.title = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        wrapper.remove();
        refreshFolderInputPlaceholders();
    });

    const pickerButton = document.createElement('button');
    pickerButton.type = 'button';
    pickerButton.className = 'folder-picker-btn';
    pickerButton.title = 'Browse for folder';
    pickerButton.setAttribute('aria-label', 'Browse for folder');
    pickerButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3.75 6.75a2.25 2.25 0 0 1 2.25-2.25h4.2c.58 0 1.13.23 1.54.64l1.12 1.11h5.14a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5v-9.75Z"/>
        </svg>
    `;
    pickerButton.addEventListener('click', () => {
        openFolderPickerForInput(input);
    });

    wrapper.appendChild(input);
    actions.appendChild(pickerButton);
    actions.appendChild(removeButton);
    wrapper.appendChild(actions);

    return wrapper;
}

function appendFolderInputField(value = '') {
    const foldersContainer = getFoldersContainer();
    const field = createFolderInputField(value);

    foldersContainer.appendChild(field);
    refreshFolderInputPlaceholders();

    return field.querySelector('.folder-input');
}

function setFolderInputs(paths = []) {
    const foldersContainer = getFoldersContainer();
    foldersContainer.replaceChildren();

    paths.forEach(folderPath => {
        foldersContainer.appendChild(createFolderInputField(folderPath));
    });

    while (foldersContainer.children.length < 2) {
        foldersContainer.appendChild(createFolderInputField(''));
    }

    refreshFolderInputPlaceholders();
}

function setScanLoading(isLoading) {
    const loader = document.getElementById('scanLoader');
    if (!loader) return;
    loader.classList.toggle('is-visible', isLoading);
}

function formatUpdateBytes(bytes = 0) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 MB';
    }

    const megabytes = bytes / (1024 * 1024);
    return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`;
}

function ensureUpdateOverlay() {
    if (updateOverlay) {
        return updateOverlay;
    }

    const overlay = document.createElement('div');
    overlay.className = 'update-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'updateOverlayTitle');

    const card = document.createElement('div');
    card.className = 'update-card';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'update-eyebrow';
    eyebrow.textContent = 'Application update';

    const title = document.createElement('h2');
    title.id = 'updateOverlayTitle';
    title.className = 'update-title';

    const message = document.createElement('p');
    message.className = 'update-message';

    const progressTrack = document.createElement('div');
    progressTrack.className = 'update-progress-track';

    const progressBar = document.createElement('div');
    progressBar.className = 'update-progress-bar';
    progressTrack.appendChild(progressBar);

    const meta = document.createElement('div');
    meta.className = 'update-meta';

    card.appendChild(eyebrow);
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(progressTrack);
    card.appendChild(meta);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    updateOverlay = {
        root: overlay,
        title,
        message,
        progressBar,
        meta
    };

    return updateOverlay;
}

function setUpdateOverlayVisible(isVisible) {
    const overlay = ensureUpdateOverlay();
    overlay.root.hidden = !isVisible;
    document.body.classList.toggle('is-update-blocked', isVisible);
}

function updateOverlayProgress(status = {}) {
    const overlay = ensureUpdateOverlay();
    const percent = Math.max(0, Math.min(100, Number(status.percent) || 0));
    const total = Number(status.total) || 0;
    const transferred = Number(status.transferred) || 0;

    overlay.progressBar.style.width = `${percent}%`;

    if (total > 0) {
        overlay.meta.textContent = `${percent.toFixed(0)}% | ${formatUpdateBytes(transferred)} of ${formatUpdateBytes(total)}`;
        return;
    }

    overlay.meta.textContent = `${percent.toFixed(0)}%`;
}

function handleUpdateStatus(status = {}) {
    if (status.state === 'downloading') {
        setUpdateOverlayVisible(true);
        const overlay = ensureUpdateOverlay();
        overlay.title.textContent = status.version
            ? `Downloading N-Way Compare v${status.version}`
            : 'Downloading N-Way Compare update';
        overlay.message.textContent = 'Please keep the app open. It will restart automatically when the update is ready to install.';
        updateOverlayProgress(status);
        return;
    }

    if (status.state === 'progress') {
        setUpdateOverlayVisible(true);
        updateOverlayProgress(status);
        return;
    }

    if (status.state === 'installing') {
        setUpdateOverlayVisible(true);
        const overlay = ensureUpdateOverlay();
        overlay.title.textContent = 'Installing update';
        overlay.message.textContent = 'The download is complete. N-Way Compare is restarting to finish the installation.';
        updateOverlayProgress({ percent: 100 });
        return;
    }

    if (status.state === 'error') {
        setUpdateOverlayVisible(true);
        const overlay = ensureUpdateOverlay();
        overlay.title.textContent = 'Update failed';
        overlay.message.textContent = status.message || 'The update could not be completed.';
        overlay.progressBar.style.width = '100%';
        overlay.meta.textContent = 'You can continue using the current version.';

        setTimeout(() => {
            setUpdateOverlayVisible(false);
        }, 4000);
        return;
    }

    if (status.state === 'idle') {
        setUpdateOverlayVisible(false);
    }
}

function ensureScanOverlay() {
    if (scanOverlay) {
        return scanOverlay;
    }

    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-labelledby', 'scanOverlayTitle');

    const card = document.createElement('div');
    card.className = 'scan-overlay-card';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'scan-overlay-eyebrow';
    eyebrow.textContent = 'Workspace scan';

    const title = document.createElement('h2');
    title.id = 'scanOverlayTitle';
    title.className = 'scan-overlay-title';
    title.textContent = 'Scanning folders';

    const message = document.createElement('p');
    message.className = 'scan-overlay-message';

    const steps = document.createElement('div');
    steps.className = 'scan-overlay-steps';

    const stepElements = SCAN_OVERLAY_STEPS.map((label, index) => {
        const step = document.createElement('div');
        step.className = 'scan-overlay-step';
        step.dataset.stepIndex = String(index);

        const marker = document.createElement('span');
        marker.className = 'scan-overlay-step-marker';

        const text = document.createElement('span');
        text.textContent = label;

        step.appendChild(marker);
        step.appendChild(text);
        steps.appendChild(step);
        return step;
    });

    card.appendChild(eyebrow);
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(steps);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    scanOverlay = {
        root: overlay,
        title,
        message,
        stepElements
    };

    return scanOverlay;
}

function setScanOverlayStep(index) {
    const overlay = ensureScanOverlay();
    scanOverlayStepIndex = clamp(index, 0, SCAN_OVERLAY_STEPS.length - 1);

    overlay.stepElements.forEach((step, stepIndex) => {
        step.classList.toggle('is-complete', stepIndex < scanOverlayStepIndex);
        step.classList.toggle('is-active', stepIndex === scanOverlayStepIndex);
    });
}

function startScanOverlay({ folderCount = 0, exclusionCount = 0 } = {}) {
    const overlay = ensureScanOverlay();
    overlay.title.textContent = 'Scanning folders';
    overlay.message.textContent = `${folderCount} folder${folderCount === 1 ? '' : 's'} queued` +
        (exclusionCount ? ` | ${exclusionCount} exclusion pattern${exclusionCount === 1 ? '' : 's'} active` : '');
    overlay.root.hidden = false;
    document.body.classList.add('is-scan-overlay-visible');
    setScanOverlayStep(0);

    if (scanOverlayTimer) {
        clearInterval(scanOverlayTimer);
    }

    scanOverlayTimer = setInterval(() => {
        setScanOverlayStep(Math.min(scanOverlayStepIndex + 1, SCAN_OVERLAY_STEPS.length - 2));
    }, 1400);
}

function finishScanOverlay() {
    if (!scanOverlay) {
        return;
    }

    if (scanOverlayTimer) {
        clearInterval(scanOverlayTimer);
        scanOverlayTimer = null;
    }

    setScanOverlayStep(SCAN_OVERLAY_STEPS.length - 1);
    scanOverlay.title.textContent = 'Rendering comparison';
}

function completeScanOverlay() {
    if (!scanOverlay) {
        return;
    }

    if (scanOverlayTimer) {
        clearInterval(scanOverlayTimer);
        scanOverlayTimer = null;
    }

    scanOverlayStepIndex = SCAN_OVERLAY_STEPS.length - 1;
    scanOverlay.root.classList.add('is-complete');
    scanOverlay.title.textContent = 'Complete';
    scanOverlay.message.textContent = 'Comparison tree is ready.';
    scanOverlay.stepElements.forEach(step => {
        step.classList.add('is-complete');
        step.classList.remove('is-active');
    });
}

function hideScanOverlay() {
    if (scanOverlayTimer) {
        clearInterval(scanOverlayTimer);
        scanOverlayTimer = null;
    }

    if (!scanOverlay) {
        return;
    }

    scanOverlay.root.hidden = true;
    scanOverlay.root.classList.remove('is-complete');
    document.body.classList.remove('is-scan-overlay-visible');
}

function waitForNextPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

function rebuildRenderCaches() {
    currentTree = groupFiles();
    currentDiffCache = new Map();
    currentStats = collectTreeStats(currentTree, currentDiffCache);
}

function createTreeFolderNode(name, relativePath) {
    return {
        name,
        __entryKey: null,
        __relativePath: relativePath,
        __files: [],
        __children: {}
    };
}

function normalizeDataPath(relativePath = '') {
    return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function normalizeDataMap(data = {}) {
    const normalized = {};

    Object.entries(data || {}).forEach(([relativePath, entry]) => {
        normalized[normalizeDataPath(relativePath)] = entry;
    });

    return normalized;
}

function buildNodeId(relativePath = '') {
    const normalizedPath = normalizeDataPath(relativePath);
    return normalizedPath ? `root/${normalizedPath}` : 'root';
}

function getParentNodeId(nodeId) {
    if (!nodeId || nodeId === 'root') {
        return null;
    }

    const parts = nodeId.split('/');
    if (parts.length <= 2) {
        return 'root';
    }

    return parts.slice(0, -1).join('/');
}

function isDirectoryEntry(entry) {
    const existingEntries = Object.values(entry || {}).filter(Boolean);
    return existingEntries.length > 0 && existingEntries.every(item => item.isDir);
}

function getTreeFolderNode(parts) {
    let node = currentTree;

    for (const part of parts) {
        node = node?.__children?.[part];

        if (!node) {
            return null;
        }
    }

    return node;
}

function ensureTreeFolderNode(parts, entryKey = null) {
    if (!currentTree) {
        currentTree = createTreeFolderNode('root', '');
    }

    let node = currentTree;
    let relativePath = '';

    parts.forEach(part => {
        relativePath = relativePath ? `${relativePath}/${part}` : part;

        if (!node.__children[part]) {
            node.__children[part] = createTreeFolderNode(part, relativePath);
        }

        node = node.__children[part];
    });

    if (entryKey !== null) {
        node.__entryKey = entryKey;
    }

    return node;
}

function pruneTreeFolders(parts) {
    for (let depth = parts.length; depth > 0; depth -= 1) {
        const nodeParts = parts.slice(0, depth);
        const node = getTreeFolderNode(nodeParts);

        if (!node) {
            continue;
        }

        if (node.__entryKey || node.__files.length || Object.keys(node.__children).length) {
            break;
        }

        const parent = depth === 1 ? currentTree : getTreeFolderNode(parts.slice(0, depth - 1));
        if (parent) {
            delete parent.__children[nodeParts[nodeParts.length - 1]];
        }
    }
}

function removeTreeEntry(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);
    if (!normalizedPath || !currentTree) {
        return;
    }

    const parts = normalizedPath.split('/');
    const parentParts = parts.slice(0, -1);
    const parent = parentParts.length ? getTreeFolderNode(parentParts) : currentTree;

    if (parent) {
        parent.__files = parent.__files.filter(file => file !== normalizedPath);
    }

    const folderNode = getTreeFolderNode(parts);
    if (folderNode) {
        const folderParent = parentParts.length ? getTreeFolderNode(parentParts) : currentTree;
        if (folderParent) {
            delete folderParent.__children[parts[parts.length - 1]];
        }
    }

    pruneTreeFolders(parentParts);
}

function upsertTreeEntry(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);
    if (!normalizedPath) {
        return;
    }

    const entry = currentData[relativePath] || currentData[normalizedPath];
    if (!entry) {
        removeTreeEntry(normalizedPath);
        return;
    }

    removeTreeEntry(normalizedPath);

    const parts = normalizedPath.split('/');

    if (isDirectoryEntry(entry)) {
        ensureTreeFolderNode(parts, normalizedPath);
        return;
    }

    const parent = ensureTreeFolderNode(parts.slice(0, -1));
    if (!parent.__files.includes(normalizedPath)) {
        parent.__files.push(normalizedPath);
    }
}

function applyTreePatch(impactedPaths) {
    if (!currentTree) {
        currentTree = createTreeFolderNode('root', '');
    }

    impactedPaths.forEach(relativePath => {
        const normalizedPath = normalizeDataPath(relativePath);

        if (!normalizedPath) {
            return;
        }

        if (currentData[relativePath] || currentData[normalizedPath]) {
            upsertTreeEntry(normalizedPath);
            return;
        }

        removeTreeEntry(normalizedPath);
    });
}

function scheduleStatsRefresh() {
    if (statsRefreshTimer) {
        clearTimeout(statsRefreshTimer);
    }

    statsRefreshTimer = setTimeout(() => {
        statsRefreshTimer = null;

        if (!currentTree) {
            currentStats = { folders: 0, files: 0, diffs: 0 };
            activeRenderController?.refreshMeta?.();
            return;
        }

        currentDiffCache = new Map();
        currentStats = collectTreeStats(currentTree, currentDiffCache);
        activeRenderController?.refreshMeta?.();
    }, 120);
}

function getParentFolderNodeId(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);

    if (!normalizedPath) {
        return 'root';
    }

    const parts = normalizedPath.split('/');
    if (parts.length <= 1) {
        return 'root';
    }

    return buildNodeId(parts.slice(0, -1).join('/'));
}

function ensurePreservedScrollState() {
    if (!preservedScrollState) {
        preservedScrollState = captureRenderScrollState();
    }
}

function applyIncrementalScanResult(scanResult) {
    if (!scanResult || typeof scanResult !== 'object') {
        currentData = normalizeDataMap(scanResult || {});
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (!scanResult.mode) {
        currentData = normalizeDataMap(scanResult);
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (scanResult.mode === 'full') {
        currentData = normalizeDataMap(scanResult.data || {});
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (scanResult.mode === 'patch') {
        if (!currentData || typeof currentData !== 'object') {
            currentData = {};
        }

        const impactedPaths = new Set();

        Object.entries(scanResult.upserts || {}).forEach(([relativePath, entry]) => {
            const normalizedPath = normalizeDataPath(relativePath);
            currentData[normalizedPath] = entry;
            impactedPaths.add(normalizedPath);
        });

        (scanResult.removals || []).forEach(relativePath => {
            const normalizedPath = normalizeDataPath(relativePath);
            delete currentData[normalizedPath];
            impactedPaths.add(normalizedPath);
        });

        return {
            changed: true,
            mode: 'patch',
            impactedPaths: Array.from(impactedPaths)
        };
    }

    if (scanResult.mode === 'noop') {
        return {
            changed: false,
            mode: 'noop',
            impactedPaths: []
        };
    }

    currentData = normalizeDataMap(scanResult.data || {});
    return {
        changed: true,
        mode: 'full',
        impactedPaths: []
    };
}

function shouldShowFullScanOverlay(nextDirs, exclusions, resetCache) {
    return Boolean(
        resetCache ||
        !currentTree ||
        !arraysEqual(nextDirs, lastWatchedDirs) ||
        !arraysEqual(exclusions, lastWatchedExclusions)
    );
}

async function performScan(resetCache = false) {
    ensurePreservedScrollState();
    setScanLoading(true);
    let fullScanOverlayVisible = false;

    try {
        dirs = getDirs();
        const exclusions = getExclusionPatterns();

        if (dirs.length < 2) {
            return alert('Please enter at least 2 folders');
        }

        const dirsChanged = !arraysEqual(dirs, lastWatchedDirs);
        const exclusionsChanged = !arraysEqual(exclusions, lastWatchedExclusions);

        if (dirsChanged && lastWatchedDirs.length) {
            clearComparisonSelections();
        }

        fullScanOverlayVisible = shouldShowFullScanOverlay(dirs, exclusions, resetCache);
        if (fullScanOverlayVisible) {
            startScanOverlay({
                folderCount: dirs.length,
                exclusionCount: exclusions.length
            });
            await waitForNextPaint();
        }

        if (resetCache) {
            Object.keys(collapseState).forEach(key => delete collapseState[key]);
        }

        const scanResult = await window.api.scan({ dirs, exclusions });
        if (fullScanOverlayVisible) {
            finishScanOverlay();
        }

        const scanUpdate = applyIncrementalScanResult(scanResult);
        const shouldRender = scanUpdate.changed || resetCache;

        if (shouldRender) {
            const canUsePatchRender = !resetCache &&
                scanUpdate.mode === 'patch' &&
                activeRenderController;

            if (canUsePatchRender) {
                applyTreePatch(scanUpdate.impactedPaths);
                currentDiffCache = new Map();
                scheduleStatsRefresh();

                const didPartialRender = activeRenderController.rerenderPaths(scanUpdate.impactedPaths);

                if (!didPartialRender) {
                    rebuildRenderCaches();
                    render();
                }
            } else {
                rebuildRenderCaches();
                render();
            }
        } else {
            preservedScrollState = null;
        }

        if (dirsChanged || exclusionsChanged) {
            window.api.watchFolders({ dirs, exclusions });
            lastWatchedDirs = [...dirs];
            lastWatchedExclusions = [...exclusions];
        }
    } catch (err) {
        preservedScrollState = null;
        hideScanOverlay();
        alert('Scan error: ' + err.message);
    } finally {
        setScanLoading(false);
        if (fullScanOverlayVisible) {
            completeScanOverlay();
            await new Promise(resolve => setTimeout(resolve, 700));
            await waitForNextPaint();
            hideScanOverlay();
        }
    }
}

function scan(resetCache = false) {
    scanQueued = true;
    queuedResetCache = queuedResetCache || resetCache;

    if (scanPromise) {
        return scanPromise;
    }

    scanPromise = (async () => {
        try {
            while (scanQueued) {
                const nextResetCache = queuedResetCache;
                scanQueued = false;
                queuedResetCache = false;
                await performScan(nextResetCache);
            }
        } finally {
            scanPromise = null;
        }
    })();

    return scanPromise;
}

window.api.onFolderChange(() => {
    window.differenceViewer?.scheduleDiskChangeCheck?.();
    scan();
});

function groupFiles() {
    const root = {
        name: 'root',
        __entryKey: '',
        __relativePath: '',
        __files: [],
        __children: {}
    };

    function ensureFolderNode(parts, entryKey = null) {
        let node = root;
        let relativePath = '';

        parts.forEach(part => {
            relativePath = relativePath ? relativePath + '/' + part : part;

            if (!node.__children[part]) {
                node.__children[part] = {
                    name: part,
                    __entryKey: null,
                    __relativePath: relativePath,
                    __files: [],
                    __children: {}
                };
            }

            node = node.__children[part];
        });

        if (entryKey !== null) {
            node.__entryKey = entryKey;
        }

        return node;
    }

    Object.keys(currentData)
        .sort((left, right) => left.localeCompare(right))
        .forEach(entryPath => {
            const entries = currentData[entryPath];
            const existingEntries = Object.values(entries).filter(Boolean);
            const parts = entryPath.split(/\\|\//).filter(Boolean);

            if (!parts.length || !existingEntries.length) {
                return;
            }

            const isDirectory = existingEntries.every(entry => entry.isDir);

            if (isDirectory) {
                ensureFolderNode(parts, entryPath);
                return;
            }

            const parentNode = ensureFolderNode(parts.slice(0, -1));
            parentNode.__files.push(entryPath);
        });

    return root;
}

function fileEntriesDiffer(entries) {
    if (!entries) return false;
    const hashes = dirs.map((_, index) => entries[index]?.hash || '__MISSING__');
    return new Set(hashes).size > 1;
}

function nodeHasDiff(node, diffCache = new Map()) {
    const cacheKey = node.__relativePath || '__root__';

    if (diffCache.has(cacheKey)) {
        return diffCache.get(cacheKey);
    }

    let hasDiff = false;

    if (node.__entryKey) {
        const folderPresence = dirs.map((_, index) => Boolean(currentData[node.__entryKey]?.[index]?.isDir));
        hasDiff = new Set(folderPresence).size > 1;
    }

    if (!hasDiff) {
        hasDiff = node.__files.some(file => fileEntriesDiffer(currentData[file]));
    }

    if (!hasDiff) {
        hasDiff = Object.values(node.__children).some(child => nodeHasDiff(child, diffCache));
    }

    diffCache.set(cacheKey, hasDiff);
    return hasDiff;
}

function collectTreeStats(node, diffCache) {
    const stats = {
        folders: 0,
        files: 0,
        diffs: 0
    };

    function visit(currentNode, includeFolder) {
        if (includeFolder) {
            stats.folders += 1;
            if (nodeHasDiff(currentNode, diffCache)) {
                stats.diffs += 1;
            }
        }

        currentNode.__files.forEach(file => {
            stats.files += 1;
            if (fileEntriesDiffer(currentData[file])) {
                stats.diffs += 1;
            }
        });

        Object.values(currentNode.__children).forEach(child => visit(child, true));
    }

    visit(node, false);
    return stats;
}

function getFolderName(fullPath) {
    if (!fullPath) return '';
    return fullPath.split(/\\|\//).filter(Boolean).pop();
}

function getFileName(fullPath) {
    return fullPath.split(/\\|\//).filter(Boolean).pop() || fullPath;
}

function getEntryMeta(entryPath) {
    const parts = entryPath.split(/\\|\//).filter(Boolean);
    if (parts.length <= 1) {
        return 'Root level';
    }

    return parts.slice(0, -1).join('/');
}

function buildFileTargetPath(dir, relativePath) {
    return dir.replace(/[\\/]+$/, '') + '/' + relativePath.replace(/^[\\/]+/, '');
}

function folderExistsInDir(dirIndex, node) {
    if (!node.__relativePath) return true;
    if (node.__entryKey && currentData[node.__entryKey]?.[dirIndex]?.isDir) return true;

    return node.__files.some(file => currentData[file]?.[dirIndex]) ||
        Object.values(node.__children).some(child => folderExistsInDir(dirIndex, child));
}

function buildGridTemplate() {
    const directoryColumns = dirs.length ? ` repeat(${dirs.length}, ${COMPARE_LAYOUT.directoryWidth}px)` : '';
    return `${COMPARE_LAYOUT.nameWidth}px${directoryColumns} minmax(${COMPARE_LAYOUT.actionsWidth}px, max-content)`;
}

function applyGridTemplate(element) {
    element.style.setProperty('--compare-grid-template', buildGridTemplate());
}

function createCompareCell(cellClassName, surfaceClassName) {
    const cell = document.createElement('div');
    cell.className = `compare-cell ${cellClassName}`.trim();

    const surface = document.createElement('div');
    surface.className = `compare-surface ${surfaceClassName}`.trim();

    cell.appendChild(surface);
    return { cell, surface };
}

function createActionButton({ label, className = '', title = '', disabled = false, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `compare-action-btn ${className}`.trim();
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
}

function createControlChip(input, label, disabled = false) {
    const chip = document.createElement('label');
    chip.className = 'compare-toggle-chip';

    if (disabled) {
        chip.classList.add('is-disabled');
    }

    chip.appendChild(input);

    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);

    return chip;
}

function createKindIcon(kind) {
    const icon = document.createElement('span');
    icon.className = `compare-kind-icon ${kind === 'DIR' ? 'is-folder' : 'is-file'}`;
    icon.title = kind === 'DIR' ? 'Folder' : 'File';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'DIR' ? '📁' : '📄';
    return icon;
}

function createDepthGuides(depth) {
    if (!depth) {
        return null;
    }

    const guides = document.createElement('div');
    guides.className = 'compare-depth-guides';

    for (let index = 0; index < depth; index += 1) {
        const guide = document.createElement('span');
        guide.className = 'compare-depth-guide';

        if (index === depth - 1) {
            guide.classList.add('is-last');
        }

        guides.appendChild(guide);
    }

    return guides;
}

function setAllFoldersExpanded(node, expanded, path = 'root') {
    collapseState[path] = expanded;

    Object.entries(node.__children).forEach(([name, child]) => {
        setAllFoldersExpanded(child, expanded, `${path}/${name}`);
    });
}

function setDiffFoldersExpanded(node, diffCache, path = 'root') {
    collapseState[path] = nodeHasDiff(node, diffCache);

    Object.entries(node.__children).forEach(([name, child]) => {
        setDiffFoldersExpanded(child, diffCache, `${path}/${name}`);
    });
}

function captureRenderScrollState() {
    const grid = document.querySelector('#fileList .compare-grid-scroll');

    return {
        pageX: window.scrollX,
        pageY: window.scrollY,
        gridTop: grid?.scrollTop ?? 0,
        gridLeft: grid?.scrollLeft ?? 0
    };
}

function restoreRenderScrollState(state) {
    if (!state) {
        return;
    }

    const restoreToken = ++scrollRestoreToken;
    const applyScrollState = () => {
        const grid = document.querySelector('#fileList .compare-grid-scroll');

        if (grid) {
            grid.scrollTop = state.gridTop;
            grid.scrollLeft = state.gridLeft;
        }

        window.scrollTo(state.pageX, state.pageY);
    };

    applyScrollState();

    requestAnimationFrame(() => {
        if (restoreToken !== scrollRestoreToken) {
            return;
        }

        applyScrollState();
        preservedScrollState = null;
    });
}

function render() {
    const list = document.getElementById('fileList');
    const onlyDiff = document.getElementById('onlyDiff').checked;
    ensurePreservedScrollState();
    const scrollState = preservedScrollState;
    const nextChildren = document.createDocumentFragment();

    if (!dirs.length) {
        dirs = getDirs();
    }

    if (!currentTree) {
        rebuildRenderCaches();
    }

    activeRenderController = null;
    const sectionStates = new Map();
    const fileRowStates = new Map();
    const selectionRefreshers = new Set();

    function getTreeNodeById(nodeId) {
        if (!currentTree || !nodeId) {
            return null;
        }

        if (nodeId === 'root') {
            return currentTree;
        }

        const parts = nodeId.split('/').slice(1);
        let node = currentTree;

        for (const part of parts) {
            node = node?.__children?.[part];

            if (!node) {
                return null;
            }
        }

        return node;
    }

    function clearSectionDescendants(nodeId) {
        const descendantPrefix = `${nodeId}/`;

        Array.from(sectionStates.keys()).forEach(key => {
            if (key.startsWith(descendantPrefix)) {
                sectionStates.delete(key);
            }
        });
    }

    function clearFileRowStatesForNode(nodeId) {
        Array.from(fileRowStates.entries()).forEach(([filePath, state]) => {
            if (state.parentNodeId === nodeId || state.parentNodeId.startsWith(`${nodeId}/`)) {
                fileRowStates.delete(filePath);
            }
        });
    }

    function registerSelectionControls({ radio, checkbox, kind, relativePath, dirIndex, exists }) {
        const refresh = () => {
            const selection = getComparisonSelection(kind, relativePath);

            if (selection?.sourceIndex === dirIndex && !exists) {
                selection.sourceIndex = null;
                cleanupComparisonSelection(selection);
            }

            radio.checked = Boolean(exists && selection?.sourceIndex === dirIndex);
            checkbox.checked = Boolean(selection?.targetIndexes.has(dirIndex));
            return true;
        };

        refresh.radio = radio;
        refresh.checkbox = checkbox;
        selectionRefreshers.add(refresh);
        refresh();
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'compare-toolbar';

    const toolbarGroup = document.createElement('div');
    toolbarGroup.className = 'compare-toolbar-group';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'app-btn app-btn-secondary';
    expandBtn.textContent = 'Expand All';
    expandBtn.addEventListener('click', () => {
        setAllFoldersExpanded(currentTree, true);
        render();
    });

    const expandDiffBtn = document.createElement('button');
    expandDiffBtn.type = 'button';
    expandDiffBtn.className = 'app-btn app-btn-secondary';
    expandDiffBtn.textContent = 'Expand Diff';
    expandDiffBtn.addEventListener('click', () => {
        setDiffFoldersExpanded(currentTree, currentDiffCache);
        render();
    });

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'app-btn app-btn-secondary';
    collapseBtn.textContent = 'Collapse All';
    collapseBtn.addEventListener('click', () => {
        setAllFoldersExpanded(currentTree, false);
        render();
    });

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'app-btn app-btn-secondary compare-history-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => undoMainAction());

    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'app-btn app-btn-secondary compare-history-btn';
    redoBtn.textContent = 'Redo';
    redoBtn.addEventListener('click', () => redoMainAction());

    const globalCopyBtn = document.createElement('button');
    globalCopyBtn.type = 'button';
    globalCopyBtn.className = 'app-btn app-btn-primary compare-history-btn';
    globalCopyBtn.textContent = 'Copy';
    globalCopyBtn.addEventListener('click', () => runGlobalMainBatchAction('copy'));

    const globalDeleteBtn = document.createElement('button');
    globalDeleteBtn.type = 'button';
    globalDeleteBtn.className = 'app-btn app-btn-danger compare-history-btn';
    globalDeleteBtn.textContent = 'Delete';
    globalDeleteBtn.addEventListener('click', () => runGlobalMainBatchAction('delete'));

    const pruneSelectionRefreshers = () => {
        Array.from(selectionRefreshers).forEach(refresh => {
            if (!refresh.radio.isConnected && !refresh.checkbox.isConnected) {
                selectionRefreshers.delete(refresh);
            }
        });
    };

    const refreshMainActionButtons = () => {
        pruneSelectionRefreshers();
        const copyPreview = buildMainBatchPreview('copy');
        const deletePreview = buildMainBatchPreview('delete');

        undoBtn.disabled = mainActionHistoryBusy || !mainActionHistoryState.canUndo;
        redoBtn.disabled = mainActionHistoryBusy || !mainActionHistoryState.canRedo;
        globalCopyBtn.disabled = mainBatchActionBusy || copyPreview.actions.length === 0;
        globalDeleteBtn.disabled = mainBatchActionBusy || deletePreview.actions.length === 0;
        undoBtn.title = mainActionHistoryState.canUndo
            ? `Undo ${mainActionHistoryState.undoLabel}`
            : 'No actions to undo';
        redoBtn.title = mainActionHistoryState.canRedo
            ? `Redo ${mainActionHistoryState.redoLabel}`
            : 'No actions to redo';
        globalCopyBtn.title = copyPreview.actions.length
            ? `Copy ${copyPreview.totalTargets} selected target${copyPreview.totalTargets === 1 ? '' : 's'}`
            : 'Select a source and target on one or more rows';
        globalDeleteBtn.title = deletePreview.actions.length
            ? `Delete ${deletePreview.totalTargets} selected existing target${deletePreview.totalTargets === 1 ? '' : 's'}`
            : 'Select existing targets on one or more rows';
    };

    toolbarGroup.appendChild(expandBtn);
    toolbarGroup.appendChild(expandDiffBtn);
    toolbarGroup.appendChild(collapseBtn);
    toolbarGroup.appendChild(undoBtn);
    toolbarGroup.appendChild(redoBtn);
    toolbarGroup.appendChild(globalCopyBtn);
    toolbarGroup.appendChild(globalDeleteBtn);
    refreshMainActionButtons();

    const meta = document.createElement('div');
    meta.className = 'compare-toolbar-meta';
    meta.textContent = `${dirs.length} folders | ${currentStats.folders} folders in tree | ${currentStats.files} files | ${currentStats.diffs} diff items`;

    toolbar.appendChild(toolbarGroup);
    toolbar.appendChild(meta);
    nextChildren.appendChild(toolbar);

    const scroll = document.createElement('div');
    scroll.className = 'compare-grid-scroll';

    const canvas = document.createElement('div');
    canvas.className = 'compare-grid-canvas';

    function createHeaderRow() {
        const row = document.createElement('div');
        row.className = 'compare-grid-row compare-grid-header';
        applyGridTemplate(row);

        const { cell: nameCell, surface: nameSurface } = createCompareCell('compare-name-cell', 'compare-header-panel');
        const nameLabel = document.createElement('div');
        nameLabel.className = 'compare-header-label';
        nameLabel.textContent = 'Path';

        const namePath = document.createElement('div');
        namePath.className = 'compare-header-path';
        namePath.textContent = 'Sticky file and folder names';

        nameSurface.appendChild(nameLabel);
        nameSurface.appendChild(namePath);
        row.appendChild(nameCell);

        dirs.forEach(dir => {
            const { cell, surface } = createCompareCell('', 'compare-header-panel');
            const label = document.createElement('div');
            label.className = 'compare-header-label';
            label.textContent = getFolderName(dir) || dir;

            const path = document.createElement('div');
            path.className = 'compare-header-path';
            path.textContent = dir;
            path.title = dir;

            surface.appendChild(label);
            surface.appendChild(path);
            row.appendChild(cell);
        });

        const { cell: actionsCell, surface: actionsSurface } = createCompareCell('compare-actions-cell', 'compare-header-panel');
        const actionLabel = document.createElement('div');
        actionLabel.className = 'compare-header-label';
        actionLabel.textContent = 'Actions';

        const actionPath = document.createElement('div');
        actionPath.className = 'compare-header-path';
        actionPath.textContent = 'Row diff tools';

        actionsSurface.appendChild(actionLabel);
        actionsSurface.appendChild(actionPath);
        row.appendChild(actionsCell);

        return row;
    }

    function createNamePanel({ depth, title, metaText, kind, hasDiff, expandable, expanded, onToggle, isFileRow = false }) {
        const { cell, surface } = createCompareCell(
            'compare-name-cell',
            `compare-name-panel${isFileRow && hasDiff ? ' is-file-diff' : ''}`
        );

        const content = document.createElement('div');
        content.className = 'compare-name-content';

        const guides = createDepthGuides(depth);
        if (guides) {
            content.appendChild(guides);
        }

        if (expandable) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = `compare-chevron${expanded ? ' is-expanded' : ''}`;
            toggleBtn.title = expanded ? 'Collapse folder' : 'Expand folder';
            toggleBtn.addEventListener('click', event => {
                event.stopPropagation();
                onToggle();
            });
            content.appendChild(toggleBtn);
        } else {
            const spacer = document.createElement('div');
            spacer.className = 'compare-node-spacer';
            content.appendChild(spacer);
        }

        const info = document.createElement('div');
        info.className = 'compare-name-info';

        const line = document.createElement('div');
        line.className = 'compare-name-line';

        const kindIcon = createKindIcon(kind);

        const titleEl = document.createElement('span');
        titleEl.className = 'compare-name-title';
        titleEl.textContent = title;
        titleEl.title = title;

        const stateBadge = document.createElement('span');
        stateBadge.className = `compare-state-badge compare-state-badge-symbol ${hasDiff ? 'is-diff' : 'is-clean'}`;
        stateBadge.textContent = hasDiff ? 'x' : '✓';
        stateBadge.title = hasDiff ? 'Diff' : 'Synced';
        stateBadge.setAttribute('aria-label', hasDiff ? 'Diff' : 'Synced');

        line.appendChild(kindIcon);
        line.appendChild(titleEl);
        line.appendChild(stateBadge);

        const path = document.createElement('div');
        path.className = 'compare-name-path';
        path.textContent = metaText;
        path.title = metaText;

        info.appendChild(line);
        info.appendChild(path);
        content.appendChild(info);
        surface.appendChild(content);

        if (expandable) {
            surface.addEventListener('click', onToggle);
            surface.style.cursor = 'pointer';
        }

        return { cell };
    }

    function createFolderSlot({ node, dir, dirIndex, fullPath, isRoot, hasDiff }) {
        const { cell, surface } = createCompareCell('', 'compare-slot');
        const relativePath = fullPath.replace(/^root[\\/]/, '');
        const folderPath = isRoot ? dir : buildFileTargetPath(dir, relativePath);
        const exists = folderExistsInDir(dirIndex, node);

        if (!exists) {
            surface.classList.add('is-missing');
        } else if (hasDiff) {
            surface.classList.add('is-diff');
        }

        surface.title = folderPath;

        const status = document.createElement('div');
        status.className = 'compare-slot-status';
        status.textContent = exists ? (hasDiff ? 'Diff' : 'Synced') : 'Missing';

        if (!exists) {
            status.classList.add('is-missing');
        } else if (hasDiff) {
            status.classList.add('is-diff');
        } else {
            status.classList.add('is-clean');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `folder-${fullPath}`;
        radio.disabled = !exists;
        radio.addEventListener('change', event => {
            event.stopPropagation();
            updateSelectionSource('folder', relativePath, dirIndex);
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = folderPath;
        checkbox.dataset.exists = exists ? 'true' : 'false';
        checkbox.addEventListener('change', event => {
            event.stopPropagation();
            updateSelectionTarget('folder', relativePath, dirIndex, checkbox.checked);
        });

        registerSelectionControls({
            radio,
            checkbox,
            kind: 'folder',
            relativePath,
            dirIndex,
            exists
        });

        const controls = document.createElement('div');
        controls.className = 'compare-slot-controls';
        controls.appendChild(createControlChip(radio, 'Source', !exists));
        controls.appendChild(createControlChip(checkbox, 'Target'));

        surface.appendChild(status);
        surface.appendChild(controls);
        return cell;
    }

    function createFileSlot({ file, dir, dirIndex, entry, rowHasDiff, sourceName }) {
        const { cell, surface } = createCompareCell('', 'compare-slot');
        const targetPath = entry?.path || buildFileTargetPath(dir, file);

        if (!entry) {
            surface.classList.add('is-missing');
        } else if (rowHasDiff) {
            surface.classList.add('is-diff');
        }

        surface.title = targetPath;

        const status = document.createElement('div');
        status.className = 'compare-slot-status';
        status.textContent = entry ? (rowHasDiff ? 'Diff' : 'Synced') : 'Missing';

        if (!entry) {
            status.classList.add('is-missing');
        } else if (rowHasDiff) {
            status.classList.add('is-diff');
        } else {
            status.classList.add('is-clean');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = sourceName;
        radio.disabled = !entry;
        radio.addEventListener('change', () => updateSelectionSource('file', file, dirIndex));

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = targetPath;
        checkbox.dataset.exists = entry ? 'true' : 'false';
        checkbox.addEventListener('change', () => updateSelectionTarget('file', file, dirIndex, checkbox.checked));

        registerSelectionControls({
            radio,
            checkbox,
            kind: 'file',
            relativePath: file,
            dirIndex,
            exists: Boolean(entry)
        });

        const controls = document.createElement('div');
        controls.className = 'compare-slot-controls';
        controls.appendChild(createControlChip(radio, 'Source', !entry));
        controls.appendChild(createControlChip(checkbox, 'Target'));

        surface.appendChild(status);
        surface.appendChild(controls);
        return cell;
    }

    function createFileRow(file, depth, parentNodeId) {
        const entries = currentData[file];
        const rowHasDiff = fileEntriesDiffer(entries);

        if (onlyDiff && !rowHasDiff) {
            fileRowStates.delete(file);
            return null;
        }

        const row = document.createElement('div');
        row.className = 'compare-grid-row compare-file-row is-hoverable';
        applyGridTemplate(row);

        const fileNameCell = createNamePanel({
            depth,
            title: getFileName(file),
            metaText: getEntryMeta(file),
            kind: 'FILE',
            hasDiff: rowHasDiff,
            expandable: false,
            expanded: false,
            onToggle: () => { },
            isFileRow: true
        });

        row.appendChild(fileNameCell.cell);

        dirs.forEach((dir, dirIndex) => {
            row.appendChild(createFileSlot({
                file,
                dir,
                dirIndex,
                entry: entries?.[dirIndex],
                rowHasDiff,
                sourceName: `file-${file}`
            }));
        });

        const { cell: fileActionCell, surface: fileActionSurface } = createCompareCell('compare-actions-cell', 'compare-actions-panel');
        const fileActionGroup = document.createElement('div');
        fileActionGroup.className = 'compare-action-group';

        const availableFiles = Object.values(entries || {}).filter(Boolean).map(entry => entry.path);

        const differenceBtn = createActionButton({
            label: 'Difference',
            className: 'is-primary',
            title: 'Open the built-in difference viewer',
            onClick: async () => {
                if (!window.differenceViewer) {
                    alert('Difference viewer is not available.');
                    return;
                }

                try {
                    await window.differenceViewer.openComparison({
                        title: getFileName(file),
                        relativePath: file,
                        panes: dirs.map((dir, dirIndex) => ({
                            label: getFolderName(dir),
                            path: entries?.[dirIndex]?.path || buildFileTargetPath(dir, file)
                        }))
                    });
                } catch (err) {
                    alert('Difference error: ' + err.message);
                }
            }
        });

        if (diffuseAvailable) {
            const diffuseBtn = createActionButton({
                label: 'Diffuse',
                title: 'Open the external multi-file diff tool',
                disabled: availableFiles.length < 2,
                onClick: async () => {
                    try {
                        await window.api.openDiffuse(availableFiles);
                    } catch (err) {
                        alert('Diffuse error: ' + err.message);
                    }
                }
            });

            fileActionGroup.appendChild(diffuseBtn);
        }

        fileActionGroup.appendChild(differenceBtn);
        fileActionSurface.appendChild(fileActionGroup);
        row.appendChild(fileActionCell);
        fileRowStates.set(file, {
            filePath: file,
            parentNodeId,
            depth,
            row
        });
        return row;
    }

    function renderNode(nodeMap, path = '', depth = 0) {
        const container = document.createElement('div');

        Object.entries(nodeMap)
            .sort(([left], [right]) => left.localeCompare(right))
            .forEach(([name, node]) => {
                const isRoot = name === 'root';
                const fullPath = path ? `${path}/${name}` : name;
                const latestNode = getTreeNodeById(fullPath) || node;
                const hasDiff = nodeHasDiff(latestNode, currentDiffCache);

                if (onlyDiff && !hasDiff) {
                    return;
                }

                const nodeId = fullPath;
                let expanded = collapseState[nodeId];

                if (expanded === undefined) {
                    expanded = hasDiff;
                    collapseState[nodeId] = expanded;
                }

                const section = document.createElement('section');
                section.className = 'compare-folder';
                section.style.setProperty('--folder-accent-color', depth > 0 ? '#d9e2ee' : 'transparent');
                section.style.setProperty('--folder-content-bg', depth > 0 ? '#fbfcfe' : 'transparent');

                const header = document.createElement('div');
                header.className = `compare-grid-row compare-folder-row is-hoverable${hasDiff ? ' is-diff' : ''}`;
                applyGridTemplate(header);

                const content = document.createElement('div');
                content.className = 'compare-folder-content';
                content.hidden = !expanded;
                const sectionState = {
                    nodeId,
                    name,
                    depth,
                    isRoot,
                    section,
                    header,
                    content,
                    contentInitialized: false,
                    populateContent: () => { },
                    renderHeader: () => { },
                    setExpandedState: () => { }
                };
                sectionStates.set(nodeId, sectionState);

                const setExpandedState = nextValue => {
                    expanded = nextValue;
                    collapseState[nodeId] = nextValue;

                    if (nextValue && !sectionState.contentInitialized) {
                        sectionState.populateContent();
                    }

                    content.hidden = !nextValue;

                    const chevron = sectionState.header.querySelector('.compare-chevron');
                    if (chevron) {
                        chevron.classList.toggle('is-expanded', nextValue);
                        chevron.title = nextValue ? 'Collapse folder' : 'Expand folder';
                    }
                };
                sectionState.setExpandedState = setExpandedState;

                sectionState.renderHeader = () => {
                    const nextNode = getTreeNodeById(nodeId) || node;
                    const nextHasDiff = nodeHasDiff(nextNode, currentDiffCache);
                    const nextHeader = document.createElement('div');
                    nextHeader.className = `compare-grid-row compare-folder-row is-hoverable${nextHasDiff ? ' is-diff' : ''}`;
                    applyGridTemplate(nextHeader);

                    const nameCell = createNamePanel({
                        depth,
                        title: isRoot ? 'Workspace root' : name,
                        metaText: isRoot ? 'Bulk actions for the selected root folders.' : nextNode.__relativePath,
                        kind: 'DIR',
                        hasDiff: nextHasDiff,
                        expandable: true,
                        expanded,
                        onToggle: () => setExpandedState(!expanded)
                    });

                    nextHeader.appendChild(nameCell.cell);

                    dirs.forEach((dir, dirIndex) => {
                        nextHeader.appendChild(createFolderSlot({
                            node: nextNode,
                            dir,
                            dirIndex,
                            fullPath,
                            isRoot,
                            hasDiff: nextHasDiff
                        }));
                    });

                    const { cell: actionCell, surface: actionSurface } = createCompareCell('compare-actions-cell', 'compare-actions-panel');
                    const actionGroup = document.createElement('div');
                    actionGroup.className = 'compare-action-group';
                    actionSurface.appendChild(actionGroup);
                    nextHeader.appendChild(actionCell);

                    if (sectionState.header && sectionState.header.parentNode) {
                        sectionState.header.parentNode.replaceChild(nextHeader, sectionState.header);
                    }

                    sectionState.header = nextHeader;
                };

                sectionState.renderHeader();

                sectionState.populateContent = (force = false) => {
                    const nextNode = getTreeNodeById(nodeId) || node;

                    if (sectionState.contentInitialized && !force) {
                        return;
                    }

                    clearSectionDescendants(nodeId);
                    clearFileRowStatesForNode(nodeId);

                    const fragment = document.createDocumentFragment();

                    [...nextNode.__files]
                        .sort((left, right) => left.localeCompare(right))
                        .forEach(file => {
                            const row = createFileRow(file, depth + 1, nodeId);

                            if (row) {
                                fragment.appendChild(row);
                            }
                        });

                    const childNodes = renderNode(nextNode.__children, fullPath, depth + 1);
                    if (childNodes.childElementCount) {
                        fragment.appendChild(childNodes);
                    }

                    content.replaceChildren(fragment);
                    sectionState.contentInitialized = true;
                };

                if (expanded) {
                    sectionState.populateContent();
                }

                section.appendChild(sectionState.header);
                section.appendChild(content);
                container.appendChild(section);
            });

        return container;
    }

    canvas.appendChild(createHeaderRow());

    const treeContent = renderNode({ root: currentTree });
    if (treeContent.childElementCount) {
        canvas.appendChild(treeContent);
    } else {
        const emptyState = document.createElement('div');
        emptyState.className = 'compare-empty-state';
        emptyState.textContent = onlyDiff
            ? 'No differences are visible for the current filter.'
            : 'Nothing to render yet. Run a scan with at least two folders.';
        canvas.appendChild(emptyState);
    }

    scroll.appendChild(canvas);
    nextChildren.appendChild(scroll);
    list.replaceChildren(nextChildren);

    function getConnectedChildFolderStates(parentNodeId) {
        return Array.from(sectionStates.values())
            .filter(state => (
                state.nodeId !== parentNodeId &&
                getParentNodeId(state.nodeId) === parentNodeId &&
                state.section?.isConnected
            ))
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    }

    activeRenderController = {
        onlyDiff,
        refreshMeta() {
            meta.textContent = `${dirs.length} folders | ${currentStats.folders} folders in tree | ${currentStats.files} files | ${currentStats.diffs} diff items`;
        },
        refreshMainActionButtons,
        refreshSelectionControls() {
            Array.from(selectionRefreshers).forEach(refresh => {
                if (!refresh.radio.isConnected && !refresh.checkbox.isConnected) {
                    selectionRefreshers.delete(refresh);
                    return;
                }

                refresh();
            });
            refreshMainActionButtons();
        },
        rerenderFileRow(filePath) {
            const normalizedPath = normalizeDataPath(filePath);
            const state = fileRowStates.get(normalizedPath);
            const nextEntry = currentData[normalizedPath];
            const parentNodeId = getParentFolderNodeId(normalizedPath);
            const parentState = sectionStates.get(parentNodeId);

            if (!state || !state.row.isConnected) {
                fileRowStates.delete(normalizedPath);

                if (!nextEntry || isDirectoryEntry(nextEntry) || !parentState || !parentState.section.isConnected) {
                    return nextEntry ? false : true;
                }

                if (!parentState.contentInitialized) {
                    return true;
                }

                const nextRow = createFileRow(normalizedPath, parentState.depth + 1, parentNodeId);
                if (!nextRow) {
                    return true;
                }

                const nextSiblingState = Array.from(fileRowStates.values())
                    .filter(fileState => fileState.parentNodeId === parentNodeId && fileState.row.isConnected && fileState.filePath.localeCompare(normalizedPath) > 0)
                    .sort((left, right) => left.filePath.localeCompare(right.filePath))[0];

                if (nextSiblingState?.row?.parentNode === parentState.content) {
                    parentState.content.insertBefore(nextRow, nextSiblingState.row);
                    return true;
                }

                const firstSection = Array.from(parentState.content.children).find(element => element.tagName === 'SECTION');
                if (firstSection) {
                    parentState.content.insertBefore(nextRow, firstSection);
                } else {
                    parentState.content.appendChild(nextRow);
                }

                return true;
            }

            if (!nextEntry || isDirectoryEntry(nextEntry)) {
                state.row.remove();
                fileRowStates.delete(normalizedPath);
                return true;
            }

            const nextRow = createFileRow(normalizedPath, state.depth, state.parentNodeId);

            if (!nextRow) {
                state.row.remove();
                fileRowStates.delete(normalizedPath);
                return true;
            }

            state.row.parentNode.replaceChild(nextRow, state.row);
            return true;
        },
        rerenderFolderSection(relativePath) {
            const normalizedPath = normalizeDataPath(relativePath);
            const nodeId = buildNodeId(normalizedPath);
            const parentNodeId = getParentFolderNodeId(normalizedPath);
            const parentState = sectionStates.get(parentNodeId);
            const existingState = sectionStates.get(nodeId);
            const nextEntry = currentData[normalizedPath];
            const nextNode = getTreeNodeById(nodeId);

            if (existingState && (!existingState.section || !existingState.section.isConnected)) {
                clearSectionDescendants(nodeId);
                clearFileRowStatesForNode(nodeId);
                sectionStates.delete(nodeId);
            }

            if (!nextEntry || !isDirectoryEntry(nextEntry) || !nextNode) {
                if (!existingState?.section?.isConnected) {
                    return !nextEntry;
                }

                clearSectionDescendants(nodeId);
                clearFileRowStatesForNode(nodeId);
                sectionStates.delete(nodeId);
                existingState.section.remove();
                return true;
            }

            if (!parentState || !parentState.section.isConnected) {
                return false;
            }

            if (!parentState.contentInitialized) {
                return true;
            }

            clearSectionDescendants(nodeId);
            clearFileRowStatesForNode(nodeId);
            sectionStates.delete(nodeId);

            const folderName = normalizedPath.split('/').pop();
            const rendered = renderNode({ [folderName]: nextNode }, parentNodeId, parentState.depth + 1);
            const nextSection = rendered.firstElementChild;

            if (!nextSection) {
                return false;
            }

            if (existingState?.section?.isConnected) {
                existingState.section.replaceWith(nextSection);
                return true;
            }

            const nextSiblingState = getConnectedChildFolderStates(parentNodeId)
                .find(state => state.nodeId.localeCompare(nodeId) > 0);

            if (nextSiblingState?.section?.parentNode === parentState.content) {
                parentState.content.insertBefore(nextSection, nextSiblingState.section);
                return true;
            }

            parentState.content.appendChild(nextSection);
            return true;
        },
        rerenderFolderContent(nodeId) {
            const state = sectionStates.get(nodeId);

            if (!state || !state.section.isConnected) {
                sectionStates.delete(nodeId);
                return false;
            }

            clearSectionDescendants(nodeId);
            clearFileRowStatesForNode(nodeId);

            if (!collapseState[nodeId]) {
                state.content.replaceChildren();
                state.contentInitialized = false;
                return true;
            }

            state.contentInitialized = false;
            state.populateContent(true);
            return true;
        },
        refreshFolderHeader(nodeId) {
            const state = sectionStates.get(nodeId);

            if (!state || !state.section.isConnected) {
                sectionStates.delete(nodeId);
                return false;
            }

            state.renderHeader();
            return true;
        },
        rerenderPaths(impactedPaths) {
            if (onlyDiff || !Array.isArray(impactedPaths) || !impactedPaths.length) {
                return false;
            }

            const patchScrollState = preservedScrollState;
            const targetContentNodeIds = new Set();
            const headerNodeIds = new Set();
            let didWork = false;

            impactedPaths.forEach(relativePath => {
                const normalizedPath = normalizeDataPath(relativePath);
                const parentNodeId = getParentFolderNodeId(normalizedPath);
                const nextEntry = currentData[normalizedPath];
                const folderNodeId = buildNodeId(normalizedPath);
                const isFileEntry = nextEntry ? !isDirectoryEntry(nextEntry) : fileRowStates.has(normalizedPath);
                const isFolderEntry = nextEntry ? isDirectoryEntry(nextEntry) : sectionStates.has(folderNodeId);

                if (!nextEntry && !fileRowStates.has(normalizedPath) && !sectionStates.has(folderNodeId)) {
                    // Ignore transient temp-file paths that were never rendered.
                } else if (isFileEntry && this.rerenderFileRow(normalizedPath)) {
                    didWork = true;
                } else if (isFolderEntry && this.rerenderFolderSection(normalizedPath)) {
                    didWork = true;
                } else {
                    targetContentNodeIds.add(parentNodeId);
                }

                let currentNodeId = parentNodeId;
                while (currentNodeId) {
                    headerNodeIds.add(currentNodeId);
                    currentNodeId = getParentNodeId(currentNodeId);
                }
            });

            Array.from(targetContentNodeIds)
                .sort((left, right) => left.length - right.length)
                .filter((nodeId, index, items) => {
                    return !items.slice(0, index).some(existing => nodeId.startsWith(`${existing}/`));
                })
                .forEach(nodeId => {
                if (this.rerenderFolderContent(nodeId)) {
                    didWork = true;
                }
            });

            Array.from(headerNodeIds)
                .sort((left, right) => right.length - left.length)
                .forEach(nodeId => {
                    if (this.refreshFolderHeader(nodeId)) {
                        didWork = true;
                    }
                });

            if (!didWork) {
                return false;
            }

            this.refreshMeta();
            restoreRenderScrollState(patchScrollState);
            return true;
        }
    };
    restoreRenderScrollState(scrollState);
}

document.getElementById('onlyDiff').onchange = render;

async function loadConfig() {
    try {
        const data = await window.api.loadConfig();
        if (!data) return;

        let folders = data;
        let exclusions = [];

        if (!Array.isArray(data)) {
            if (!data || typeof data !== 'object' || !Array.isArray(data.folders)) {
                return alert('Invalid config format. Expected an array or { folders, exclusions }.');
            }

            folders = data.folders;
            exclusions = Array.isArray(data.exclusions) ? data.exclusions : [];
        }

        setFolderInputs(folders);
        setExclusionPatterns(exclusions);

        if (getDirs().length >= 2) {
            setScanLoading(true);
            await waitForNextPaint();
            await scan(true);
        }
    } catch (err) {
        alert('Error loading config: ' + err.message);
    }
}

async function saveConfig() {
    try {
        const inputs = document.querySelectorAll('.folder-input');
        const paths = Array.from(inputs)
            .map(input => input.value.trim())
            .filter(Boolean);
        const exclusions = getExclusionPatterns();

        if (paths.length < 2) {
            return alert('Add at least 2 folders to save config');
        }

        await window.api.saveConfig({
            folders: paths,
            exclusions
        });
        alert('Config saved!');
    } catch (err) {
        alert('Error saving config: ' + err.message);
    }
}

async function runCmd() {
    const input = document.getElementById('cmdInput');
    const command = input.value.trim();

    if (!command) return alert('Enter command');

    dirs = getDirs();

    if (!dirs.length) return alert('No folders');

    try {
        await window.api.runCommand({ dirs, command });
        alert('Command executed!');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

window.runCmd = runCmd;
window.saveConfig = saveConfig;
window.loadConfig = loadConfig;
window.scan = scan;

if (window.api.onUpdateStatus) {
    window.api.onUpdateStatus(handleUpdateStatus);
}

document.getElementById('addFolderBtn').addEventListener('click', async () => {
    const input = appendFolderInputField('');
    await openFolderPickerForInput(input);
});

document.getElementById('loadConfigBtn').addEventListener('click', () => loadConfig());
document.getElementById('saveConfigBtn').addEventListener('click', () => saveConfig());
document.getElementById('scanBtn').addEventListener('click', () => scan());
document.getElementById('runCmdBtn').addEventListener('click', () => runCmd());

document.addEventListener('keydown', event => {
    const target = event.target;
    const isTypingTarget = target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);

    if (
        event.defaultPrevented ||
        window.differenceViewer?.isOpen?.() ||
        isTypingTarget ||
        !(event.ctrlKey || event.metaKey)
    ) {
        return;
    }

    const key = event.key.toLowerCase();
    const shouldUndo = key === 'z' && !event.shiftKey;
    const shouldRedo = key === 'y' || (key === 'z' && event.shiftKey);

    if (!shouldUndo && !shouldRedo) {
        return;
    }

    event.preventDefault();

    if (shouldUndo) {
        undoMainAction();
    } else {
        redoMainAction();
    }
});

setFolderInputs(Array.from(document.querySelectorAll('#folders .folder-input')).map(input => input.value));
refreshMainActionHistoryState();
ensureDiffuseAvailability();
