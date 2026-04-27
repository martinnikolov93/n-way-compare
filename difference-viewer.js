(function () {
    const STORAGE_KEY = 'difference-viewer.tabs.v1';
    const ACTIVE_KEY = 'difference-viewer.active-key.v1';
    const LINE_GUTTER_WIDTH = 38;

    function basename(filePath) {
        if (!filePath) return 'Untitled';
        const parts = filePath.split(/\\|\//).filter(Boolean);
        return parts[parts.length - 1] || filePath;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function mergeRanges(ranges) {
        if (!ranges.length) {
            return [];
        }

        const sorted = ranges
            .filter(range => range.end > range.start)
            .sort((left, right) => left.start - right.start);

        if (!sorted.length) {
            return [];
        }

        const merged = [sorted[0]];

        for (let index = 1; index < sorted.length; index += 1) {
            const current = sorted[index];
            const previous = merged[merged.length - 1];

            if (current.start <= previous.end) {
                previous.end = Math.max(previous.end, current.end);
                continue;
            }

            merged.push({ ...current });
        }

        return merged;
    }

    class DifferenceViewer {
        constructor(api) {
            this.api = api;
            this.tabs = [];
            this.activeTabId = null;
            this.savedTabsRestored = false;
            this.paneMinWidth = 500;
            this.paneMaxWidth = 500;
            this.isSyncingTabScroll = false;
            this.rowElements = [];
            this.cellElements = [];
            this.headerElements = [];
            this.codeScrollerElements = [];
            this.codeContentElements = [];
            this.paneScrollbarElements = [];
            this.paneScrollbarSpacerElements = [];
            this.pendingPaneScrollUpdates = new Map();
            this.pendingPaneScrollFrame = 0;
            this.isSyncingPaneScroll = false;
            this.gridScroll = null;
            this.gridEl = null;
            this.rowsHostEl = null;
            this.headersContainerEl = null;
            this.scrollbarRowEl = null;
            this.overviewEl = null;
            this.overviewTrackEl = null;
            this.overviewViewportEl = null;
            this.overviewSelectionEl = null;
            this.isDraggingOverview = false;
            this.activeTemplateColumns = '';
            this.activeRenderedTabId = null;
            this.visibleRowRange = null;
            this.virtualRowHeight = 20;
            this.virtualRowOverscan = 40;
            this.selectionRepeatIntervalMs = 40;
            this.pendingSelectionMove = null;
            this.pendingSelectionMoveFrame = 0;
            this.lastSelectionMoveAt = 0;
            this.dragSelection = null;
            this.transientSelectionFlash = null;
            this.transientSelectionFlashTimer = 0;
            this.inlineEditor = null;
            this.pendingRowReveal = null;
            this.pendingViewerOpenScrollReset = null;
            this.lastStatus = 'Open a file from the Difference button to compare and merge changes.';
            this.compareResults = document.getElementById('fileList');
            this.compareResultsPreviousHeight = null;
            this.pendingDiskChangeCheckTimer = 0;
            this.pendingDiskChangeNoticeItems = [];
            this.diskChangeNoticeOpen = false;
            this.diskChangeNoticeDirty = false;

            this.build();
            document.addEventListener('keydown', this.handleKeyDown.bind(this));
            document.addEventListener('keyup', this.handleKeyUp.bind(this));
            document.addEventListener('mousemove', this.handleGlobalMouseMove.bind(this));
            document.addEventListener('mouseup', this.handleGlobalMouseUp.bind(this));
            window.addEventListener('resize', () => this.updateOverviewViewport());
        }

        build() {
            this.modal = document.createElement('div');
            this.modal.className = 'difference-modal';

            const dialog = document.createElement('div');
            dialog.className = 'difference-dialog';

            const header = document.createElement('div');
            header.className = 'difference-header';

            const headerMain = document.createElement('div');
            headerMain.className = 'difference-header-main';

            this.headerTitleEl = document.createElement('div');
            this.headerTitleEl.className = 'difference-header-title';
            this.headerTitleEl.textContent = 'Difference';

            this.headerSubtitleEl = document.createElement('div');
            this.headerSubtitleEl.className = 'difference-header-subtitle';
            this.headerSubtitleEl.textContent = this.lastStatus;

            headerMain.appendChild(this.headerTitleEl);
            headerMain.appendChild(this.headerSubtitleEl);

            const headerActions = document.createElement('div');
            headerActions.className = 'difference-header-actions';

            this.saveAllBtn = this.createActionButton({
                className: 'difference-header-btn',
                label: 'Save All',
                title: 'Save all dirty tabs (Ctrl+S)',
                onClick: () => this.saveAllTabs().catch(err => this.setStatus('Save failed: ' + err.message))
            });

            this.reloadBtn = this.createActionButton({
                className: 'difference-header-btn',
                label: 'Reload',
                title: 'Reload active tab from disk',
                onClick: () => this.reloadActiveTab().catch(err => this.setStatus('Reload failed: ' + err.message))
            });

            const closeBtn = this.createActionButton({
                className: 'difference-close-btn',
                label: 'X',
                title: 'Close difference popup (Esc)',
                onClick: () => this.close()
            });

            headerActions.appendChild(this.saveAllBtn);
            headerActions.appendChild(this.reloadBtn);
            headerActions.appendChild(closeBtn);

            header.appendChild(headerMain);
            header.appendChild(headerActions);

            const tabsOuter = document.createElement('div');
            tabsOuter.className = 'difference-tabs-outer';

            this.tabsScrollEl = document.createElement('div');
            this.tabsScrollEl.className = 'difference-tabs-scroll';

            this.tabsEl = document.createElement('div');
            this.tabsEl.className = 'difference-tabs';
            this.tabsScrollEl.appendChild(this.tabsEl);

            this.tabScrollbarEl = document.createElement('div');
            this.tabScrollbarEl.className = 'difference-tab-scrollbar';

            this.tabScrollbarSpacerEl = document.createElement('div');
            this.tabScrollbarSpacerEl.className = 'difference-tab-scrollbar-spacer';
            this.tabScrollbarEl.appendChild(this.tabScrollbarSpacerEl);

            this.tabsScrollEl.addEventListener('scroll', () => this.syncTabScroll(this.tabsScrollEl, this.tabScrollbarEl));
            this.tabScrollbarEl.addEventListener('scroll', () => this.syncTabScroll(this.tabScrollbarEl, this.tabsScrollEl));

            tabsOuter.appendChild(this.tabsScrollEl);
            tabsOuter.appendChild(this.tabScrollbarEl);

            const toolbar = document.createElement('div');
            toolbar.className = 'difference-toolbar';

            const navigationGroup = document.createElement('div');
            navigationGroup.className = 'difference-toolbar-group';
            navigationGroup.appendChild(this.createToolbarLabel('Changes'));
            this.prevHunkBtn = this.createToolbarButton('Prev', 'Alt+Up', 'Jump to previous diff hunk', () => this.navigateHunk(-1));
            this.nextHunkBtn = this.createToolbarButton('Next', 'Alt+Down', 'Jump to next diff hunk', () => this.navigateHunk(1));
            navigationGroup.appendChild(this.prevHunkBtn);
            navigationGroup.appendChild(this.nextHunkBtn);

            const transferGroup = document.createElement('div');
            transferGroup.className = 'difference-toolbar-group';
            transferGroup.appendChild(this.createToolbarLabel('Transfer'));
            this.copySelectionLeftBtn = this.createToolbarButton('Sel -> L', 'Shift+Ctrl+Left', 'Copy the current selection into the file on the left', () => this.copySelectionToNeighbor(-1));
            this.copySelectionRightBtn = this.createToolbarButton('Sel -> R', 'Shift+Ctrl+Right', 'Copy the current selection into the file on the right', () => this.copySelectionToNeighbor(1));
            this.copyLeftIntoSelectionBtn = this.createToolbarButton('L -> Sel', 'Ctrl+Right', 'Replace the current selection with the aligned text from the left file', () => this.copyNeighborIntoSelection(-1));
            this.copyRightIntoSelectionBtn = this.createToolbarButton('R -> Sel', 'Ctrl+Left', 'Replace the current selection with the aligned text from the right file', () => this.copyNeighborIntoSelection(1));
            this.mergeLeftRightBtn = this.createToolbarButton('L + R', 'Ctrl+M', 'Merge left selection, then right selection, into the active file', () => this.mergeSelection('left-right'));
            this.mergeRightLeftBtn = this.createToolbarButton('R + L', 'Shift+Ctrl+M', 'Merge right selection, then left selection, into the active file', () => this.mergeSelection('right-left'));
            transferGroup.appendChild(this.copySelectionLeftBtn);
            transferGroup.appendChild(this.copySelectionRightBtn);
            transferGroup.appendChild(this.copyLeftIntoSelectionBtn);
            transferGroup.appendChild(this.copyRightIntoSelectionBtn);
            transferGroup.appendChild(this.mergeLeftRightBtn);
            transferGroup.appendChild(this.mergeRightLeftBtn);

            const layoutGroup = document.createElement('div');
            layoutGroup.className = 'difference-toolbar-group';
            layoutGroup.appendChild(this.createToolbarLabel('Layout'));
            this.minWidthInput = this.createToolbarNumberInput('Min width', this.paneMinWidth, (value) => {
                this.applyPaneWidthChange('min', value);
            });
            this.maxWidthInput = this.createToolbarNumberInput('Max width', this.paneMaxWidth, (value) => {
                this.applyPaneWidthChange('max', value);
            });
            layoutGroup.appendChild(this.minWidthInput.wrapper);
            layoutGroup.appendChild(this.maxWidthInput.wrapper);

            toolbar.appendChild(navigationGroup);
            toolbar.appendChild(transferGroup);
            toolbar.appendChild(layoutGroup);

            this.statusbarEl = document.createElement('div');
            this.statusbarEl.className = 'difference-statusbar';
            this.statusbarEl.textContent = this.lastStatus;

            this.bodyEl = document.createElement('div');
            this.bodyEl.className = 'difference-body';

            dialog.appendChild(header);
            dialog.appendChild(tabsOuter);
            dialog.appendChild(toolbar);
            dialog.appendChild(this.statusbarEl);
            dialog.appendChild(this.bodyEl);

            this.modal.appendChild(dialog);
            this.buildDiskChangeNotice(dialog);
            document.body.appendChild(this.modal);
        }

        buildDiskChangeNotice(dialog) {
            this.diskChangeNoticeEl = document.createElement('div');
            this.diskChangeNoticeEl.className = 'difference-disk-notice';
            this.diskChangeNoticeEl.hidden = true;

            const card = document.createElement('div');
            card.className = 'difference-disk-notice-card';

            const title = document.createElement('div');
            title.className = 'difference-disk-notice-title';
            title.textContent = 'Some open files changed on disk.';

            const subtitle = document.createElement('div');
            subtitle.className = 'difference-disk-notice-subtitle';
            subtitle.textContent = 'Please review them before continuing.';

            this.diskChangeNoticeListEl = document.createElement('div');
            this.diskChangeNoticeListEl.className = 'difference-disk-notice-list';

            const actions = document.createElement('div');
            actions.className = 'difference-disk-notice-actions';

            const reviewBtn = this.createActionButton({
                className: 'difference-header-btn',
                label: 'Review changed files',
                title: 'Close this notice and review the highlighted files',
                onClick: () => this.reviewDiskChanges()
            });

            actions.appendChild(reviewBtn);
            card.appendChild(title);
            card.appendChild(subtitle);
            card.appendChild(this.diskChangeNoticeListEl);
            card.appendChild(actions);
            this.diskChangeNoticeEl.appendChild(card);
            dialog.appendChild(this.diskChangeNoticeEl);
        }

        createActionButton({ className, label, title, onClick }) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = label;
            button.title = title;
            button.addEventListener('click', onClick);
            return button;
        }

        createToolbarLabel(text) {
            const label = document.createElement('div');
            label.className = 'difference-toolbar-label';
            label.textContent = text;
            return label;
        }

        createToolbarButton(label, shortcut, description, handler) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'difference-toolbar-btn';
            button.title = description + ' (' + shortcut + ')';
            button.addEventListener('click', handler);

            const labelEl = document.createElement('span');
            labelEl.textContent = label;

            const shortcutEl = document.createElement('kbd');
            shortcutEl.textContent = shortcut;

            button.appendChild(labelEl);
            button.appendChild(shortcutEl);
            return button;
        }

        createToolbarNumberInput(label, value, onCommit) {
            const wrapper = document.createElement('label');
            wrapper.className = 'difference-toolbar-input';

            const labelEl = document.createElement('span');
            labelEl.className = 'difference-toolbar-input-label';
            labelEl.textContent = label;

            const input = document.createElement('input');
            input.type = 'number';
            input.min = '120';
            input.step = '10';
            input.value = String(value);
            input.className = 'difference-toolbar-number';

            const commit = () => {
                const parsed = Number.parseInt(input.value, 10);
                onCommit(Number.isFinite(parsed) ? parsed : value);
                input.value = String(label === 'Min width' ? this.paneMinWidth : this.paneMaxWidth);
            };

            input.addEventListener('change', commit);
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }
            });

            wrapper.appendChild(labelEl);
            wrapper.appendChild(input);

            return { wrapper, input };
        }

        applyPaneWidthChange(kind, value) {
            const normalized = Math.max(120, Number.isFinite(value) ? value : 500);

            if (kind === 'min') {
                this.paneMinWidth = normalized;
                if (this.paneMaxWidth < this.paneMinWidth) {
                    this.paneMaxWidth = this.paneMinWidth;
                }
            } else {
                this.paneMaxWidth = normalized;
                if (this.paneMinWidth > this.paneMaxWidth) {
                    this.paneMinWidth = this.paneMaxWidth;
                }
            }

            if (this.minWidthInput?.input) {
                this.minWidthInput.input.value = String(this.paneMinWidth);
            }

            if (this.maxWidthInput?.input) {
                this.maxWidthInput.input.value = String(this.paneMaxWidth);
            }

            if (this.getActiveTab()) {
                this.render();
            }
        }

        getPaneTemplateColumns(tab) {
            const minWidth = this.paneMinWidth;
            const maxWidth = this.paneMaxWidth;
            const track = minWidth === maxWidth
                ? `${minWidth}px`
                : `minmax(${minWidth}px, ${maxWidth}px)`;

            return `repeat(${tab.panes.length}, ${track})`;
        }

        isImageFilePath(filePath) {
            return Boolean(window.DifferenceFileTypes?.isImageFilePath?.(filePath));
        }

        getMimeTypeForFilePath(filePath) {
            return window.DifferenceFileTypes?.getMimeTypeForFilePath?.(filePath) || '';
        }

        getDescriptorMode(descriptor) {
            const panes = Array.isArray(descriptor?.panes) ? descriptor.panes : [];

            return panes.length && panes.every((pane) => this.isImageFilePath(pane?.path))
                ? 'image'
                : 'text';
        }

        isImageTab(tab) {
            return tab?.mode === 'image';
        }

        getPaneStateText(tab, pane) {
            if (pane.error) {
                return 'Load error';
            }

            if (this.hasPaneDiskConflict(pane)) {
                return pane.dirty && !this.isImageTab(tab)
                    ? 'Changed on disk + local edits'
                    : 'Changed on disk';
            }

            if (!pane.exists) {
                return 'Missing on disk';
            }

            if (this.isImageTab(tab)) {
                return 'Image preview only';
            }

            return pane.dirty ? 'Modified locally' : 'On disk';
        }

        createPaneHeader(tab, pane, paneIndex) {
            const header = document.createElement('div');
            header.className = 'difference-pane-header' + (paneIndex === tab.focusPaneIndex ? ' is-active' : '');
            header.style.minWidth = this.paneMinWidth + 'px';
            header.style.maxWidth = this.paneMaxWidth + 'px';

            const labelRow = document.createElement('div');
            labelRow.className = 'difference-pane-label-row';

            const label = document.createElement('div');
            label.className = 'difference-pane-label';
            label.textContent = pane.label;

            const saveBtn = document.createElement('button');
            const imageTab = this.isImageTab(tab);
            const interactionLocked = this.tabHasUnresolvedDiskChanges(tab);
            saveBtn.type = 'button';
            saveBtn.className = 'difference-pane-btn' + (pane.dirty && !imageTab && !interactionLocked ? '' : ' is-disabled');
            saveBtn.textContent = imageTab ? 'View' : (pane.dirty ? 'Save' : 'Saved');
            saveBtn.title = imageTab
                ? 'Image preview is read-only in this version'
                : interactionLocked
                    ? 'Resolve files changed on disk before saving'
                    : 'Save this file';
            saveBtn.addEventListener('click', () => {
                if (imageTab || !pane.dirty || interactionLocked) {
                    return;
                }

                this.savePane(tab, paneIndex)
                    .then(() => this.render())
                    .catch(err => this.setStatus('Save failed: ' + err.message));
            });

            labelRow.appendChild(label);
            labelRow.appendChild(saveBtn);

            const filePath = document.createElement('div');
            filePath.className = 'difference-pane-file';
            filePath.textContent = pane.path;
            filePath.title = pane.path;

            const state = document.createElement('div');
            state.className = 'difference-pane-state' + (
                this.hasPaneDiskConflict(pane)
                    ? ' is-warning'
                    : (!imageTab && pane.dirty ? ' is-dirty' : '')
            );
            state.textContent = this.getPaneStateText(tab, pane);

            header.addEventListener('click', () => {
                if (tab.focusPaneIndex === paneIndex) {
                    return;
                }

                tab.focusPaneIndex = paneIndex;
                this.render();
            });

            header.appendChild(labelRow);
            header.appendChild(filePath);
            header.appendChild(state);
            this.headerElements[paneIndex] = header;
            return header;
        }

        createDiskSnapshot(filePath = '', exists = false, size = null, mtimeMs = null) {
            return {
                path: filePath,
                exists: Boolean(exists),
                size: Number.isFinite(size) ? size : null,
                mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null
            };
        }

        extractDiskSnapshot(result, filePath = '') {
            return this.createDiskSnapshot(
                filePath || result?.path || '',
                Boolean(result?.exists),
                result?.size,
                result?.mtimeMs
            );
        }

        diskSnapshotsEqual(left, right) {
            const leftExists = Boolean(left?.exists);
            const rightExists = Boolean(right?.exists);

            if (leftExists !== rightExists) {
                return false;
            }

            if (!leftExists && !rightExists) {
                return true;
            }

            return (
                Number(left?.size ?? -1) === Number(right?.size ?? -1) &&
                Number(left?.mtimeMs ?? -1) === Number(right?.mtimeMs ?? -1)
            );
        }

        getPaneConflictKey(tab, paneIndex) {
            return `${tab?.id || 'tab'}::${paneIndex}`;
        }

        hasPaneDiskConflict(pane) {
            return Boolean(pane?.diskChange);
        }

        tabHasUnresolvedDiskChanges(tab) {
            return Boolean(tab?.panes?.some((pane) => this.hasPaneDiskConflict(pane)));
        }

        hasAnyUnresolvedDiskChanges() {
            return this.tabs.some((tab) => this.tabHasUnresolvedDiskChanges(tab));
        }

        getDiskConflictEntries(includeAllTabs = true) {
            const entries = [];

            this.tabs.forEach((tab) => {
                if (!includeAllTabs && tab.id !== this.activeTabId) {
                    return;
                }

                tab.panes.forEach((pane, paneIndex) => {
                    if (!this.hasPaneDiskConflict(pane)) {
                        return;
                    }

                    entries.push({
                        key: this.getPaneConflictKey(tab, paneIndex),
                        tab,
                        pane,
                        paneIndex
                    });
                });
            });

            return entries;
        }

        queueDiskChangeNotice(items) {
            if (!Array.isArray(items) || !items.length) {
                return;
            }

            const knownKeys = new Set(this.pendingDiskChangeNoticeItems.map((item) => item.key));

            items.forEach((item) => {
                if (!item || knownKeys.has(item.key)) {
                    return;
                }

                knownKeys.add(item.key);
                this.pendingDiskChangeNoticeItems.push(item);
            });

            this.diskChangeNoticeDirty = true;
            if (this.isOpen()) {
                this.showDiskChangeNotice();
            }
        }

        refreshDiskChangeNoticeList() {
            if (!this.diskChangeNoticeListEl) {
                return;
            }

            this.diskChangeNoticeListEl.innerHTML = '';
            const unresolvedEntries = this.getDiskConflictEntries(true);

            unresolvedEntries.forEach((entry) => {
                const item = document.createElement('div');
                item.className = 'difference-disk-notice-item';

                const title = document.createElement('div');
                title.className = 'difference-disk-notice-item-title';
                title.textContent = `${entry.tab.relativePath} • ${entry.pane.label}`;

                const pathEl = document.createElement('div');
                pathEl.className = 'difference-disk-notice-item-path';
                pathEl.textContent = entry.pane.path;

                item.appendChild(title);
                item.appendChild(pathEl);
                this.diskChangeNoticeListEl.appendChild(item);
            });

            this.diskChangeNoticeDirty = false;
        }

        showDiskChangeNotice(force = false) {
            if (!this.diskChangeNoticeEl) {
                return;
            }

            if (!force && !this.hasAnyUnresolvedDiskChanges() && !this.pendingDiskChangeNoticeItems.length) {
                this.hideDiskChangeNotice();
                return;
            }

            if (this.diskChangeNoticeDirty || force) {
                this.refreshDiskChangeNoticeList();
            }

            this.diskChangeNoticeOpen = true;
            this.diskChangeNoticeEl.hidden = false;
            this.pendingDiskChangeNoticeItems = [];
        }

        hideDiskChangeNotice() {
            if (!this.diskChangeNoticeEl) {
                return;
            }

            this.diskChangeNoticeOpen = false;
            this.diskChangeNoticeEl.hidden = true;
        }

        reviewDiskChanges() {
            const unresolvedEntries = this.getDiskConflictEntries(true);

            if (!unresolvedEntries.length) {
                this.hideDiskChangeNotice();
                return;
            }

            const activeTab = this.getActiveTab();
            const targetEntry = (activeTab
                ? unresolvedEntries.find((entry) => entry.tab.id === activeTab.id)
                : null) || unresolvedEntries[0];

            if (!targetEntry) {
                this.hideDiskChangeNotice();
                return;
            }

            targetEntry.tab.focusPaneIndex = targetEntry.paneIndex;

            if (this.activeTabId !== targetEntry.tab.id) {
                this.activeTabId = targetEntry.tab.id;
                this.persistTabs();
            }

            this.hideDiskChangeNotice();
            this.render();
            this.setStatus('Reviewing files changed on disk.', true);
        }

        clearPaneDiskConflict(tab, paneIndex) {
            const pane = tab?.panes?.[paneIndex];
            if (!pane) {
                return;
            }

            pane.diskChange = null;
            this.pendingDiskChangeNoticeItems = this.pendingDiskChangeNoticeItems
                .filter((item) => item.key !== this.getPaneConflictKey(tab, paneIndex));

            if (!this.hasAnyUnresolvedDiskChanges()) {
                this.hideDiskChangeNotice();
            } else {
                this.diskChangeNoticeDirty = true;
                if (this.diskChangeNoticeOpen) {
                    this.refreshDiskChangeNoticeList();
                }
            }
        }

        isActiveTabInteractionLocked() {
            return this.tabHasUnresolvedDiskChanges(this.getActiveTab());
        }

        ensureWritableActiveTab(actionLabel = 'continue') {
            if (!this.isActiveTabInteractionLocked()) {
                return true;
            }

            this.showDiskChangeNotice(true);
            this.setStatus('Resolve files changed on disk before you ' + actionLabel + '.', true);
            return false;
        }

        setSelection(tab, paneIndex, startRow, endRow, anchorRow = startRow, activeRow = endRow) {
            tab.selection = {
                paneIndex,
                startRow: Math.min(startRow, endRow),
                endRow: Math.max(startRow, endRow),
                anchorRow,
                activeRow
            };
        }

        ensurePaneScrollState(tab) {
            if (!Array.isArray(tab.paneScrollLefts) || tab.paneScrollLefts.length !== tab.panes.length) {
                tab.paneScrollLefts = Array.from({ length: tab.panes.length }, (_, paneIndex) => tab.paneScrollLefts?.[paneIndex] || 0);
            }
        }

        refreshSelectionVisuals() {
            const tab = this.getActiveTab();
            const selection = tab?.selection || null;
            const flash = tab && this.transientSelectionFlash?.tabId === tab.id
                ? this.transientSelectionFlash
                : null;

            this.headerElements.forEach((headerEl, paneIndex) => {
                if (!headerEl || !tab) {
                    return;
                }

                headerEl.classList.toggle('is-active', paneIndex === tab.focusPaneIndex);
            });

            this.cellElements.forEach((rowCells, rowIndex) => {
                if (!Array.isArray(rowCells)) {
                    return;
                }

                rowCells.forEach((cellEl, paneIndex) => {
                    if (!cellEl) {
                        return;
                    }

                    const isSelected = Boolean(
                        selection &&
                        selection.paneIndex === paneIndex &&
                        rowIndex >= selection.startRow &&
                        rowIndex <= selection.endRow
                    );
                    const isDeleteFlash = Boolean(
                        flash &&
                        flash.paneIndex === paneIndex &&
                        rowIndex >= flash.startRow &&
                        rowIndex <= flash.endRow
                    );

                    cellEl.classList.toggle('is-selected', isSelected);
                    cellEl.classList.toggle('is-active-pane', paneIndex === tab.focusPaneIndex);
                    cellEl.classList.toggle('is-delete-flash', isDeleteFlash);
                });
            });

            if (tab) {
                this.updateStatusForTab(tab);
                this.updateToolbarState();
                this.updateOverviewSelection();
            }
        }

        getDifferenceRanges(sourceText, compareText) {
            return window.DifferenceInlineDiff.getDifferenceRanges(sourceText, compareText);
        }

        tokenizeInlineDifference(text) {
            return window.DifferenceInlineDiff.tokenizeInlineDifference(text);
        }

        getTokenDifferenceRanges(sourceText, compareText, sourceOffset) {
            return window.DifferenceInlineDiff.getTokenDifferenceRanges(sourceText, compareText, sourceOffset);
        }

        getChangedRangesForCell(row, paneIndex) {
            const cell = row.cells[paneIndex];
            if (!cell || cell.missing || !cell.text) {
                return [];
            }

            const ranges = [];
            const leftCell = row.cells[paneIndex - 1];
            const rightCell = row.cells[paneIndex + 1];
            let comparedExistingCell = false;

            if (cell.changedLeft && leftCell && !leftCell.missing) {
                comparedExistingCell = true;
                ranges.push(...this.getDifferenceRanges(cell.text, leftCell.text));
            }

            if (cell.changedRight && rightCell && !rightCell.missing) {
                comparedExistingCell = true;
                ranges.push(...this.getDifferenceRanges(cell.text, rightCell.text));
            }

            if ((cell.changedLeft || cell.changedRight) && !ranges.length && !comparedExistingCell) {
                ranges.push({ start: 0, end: cell.text.length });
            }

            return mergeRanges(ranges);
        }

        renderCodeMarkup(row, paneIndex) {
            const cell = row.cells[paneIndex];

            if (!cell || cell.missing) {
                return 'Missing in this file';
            }

            const text = cell.text.length ? cell.text : ' ';
            const ranges = this.getChangedRangesForCell(row, paneIndex);
            if (!ranges.length) {
                return escapeHtml(text);
            }

            let cursor = 0;
            const parts = [];

            ranges.forEach(range => {
                if (range.start > cursor) {
                    parts.push(escapeHtml(text.slice(cursor, range.start)));
                }

                parts.push('<span class="difference-inline-change">' + escapeHtml(text.slice(range.start, range.end)) + '</span>');
                cursor = range.end;
            });

            if (cursor < text.length) {
                parts.push(escapeHtml(text.slice(cursor)));
            }

            return parts.join('');
        }

        renderCodeContent(codeEl, row, paneIndex) {
            const cell = row.cells[paneIndex];

            if (!cell || cell.missing) {
                codeEl.textContent = 'Missing in this file';
                return;
            }

            const text = cell.text.length ? cell.text : ' ';
            if (!cell.changedLeft && !cell.changedRight) {
                codeEl.textContent = text;
                return;
            }

            const ranges = this.getChangedRangesForCell(row, paneIndex);
            if (!ranges.length) {
                codeEl.textContent = text;
                return;
            }

            let cursor = 0;
            const parts = [];

            ranges.forEach(range => {
                if (range.start > cursor) {
                    parts.push(escapeHtml(text.slice(cursor, range.start)));
                }

                parts.push('<span class="difference-inline-change">' + escapeHtml(text.slice(range.start, range.end)) + '</span>');
                cursor = range.end;
            });

            if (cursor < text.length) {
                parts.push(escapeHtml(text.slice(cursor)));
            }

            codeEl.innerHTML = parts.join('');
        }

        getCellLocationFromTarget(target) {
            const cellEl = target?.closest?.('.difference-cell');
            if (!cellEl) {
                return null;
            }

            const paneIndex = Number(cellEl.dataset.paneIndex);
            const rowIndex = Number(cellEl.dataset.rowIndex);
            if (Number.isNaN(paneIndex) || Number.isNaN(rowIndex)) {
                return null;
            }

            return {
                cellEl,
                paneIndex,
                rowIndex
            };
        }

        handleGridMouseDown(event) {
            const location = this.getCellLocationFromTarget(event.target);
            if (!location) {
                return;
            }

            this.handleCellMouseDown(location.paneIndex, location.rowIndex, event);
        }

        handleGridDoubleClick(event) {
            const location = this.getCellLocationFromTarget(event.target);
            if (!location) {
                return;
            }

            event.preventDefault();
            this.beginInlineEdit(location.paneIndex, location.rowIndex);
        }

        handleCellMouseDown(paneIndex, rowIndex, event) {
            if (event.button !== 0) {
                return;
            }

            if (this.inlineEditor) {
                this.finishInlineEdit({ commit: true });
            }

            event.preventDefault();

            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            tab.focusPaneIndex = paneIndex;

            const anchor = event.shiftKey && tab.selection && tab.selection.paneIndex === paneIndex
                ? (tab.selection.anchorRow ?? tab.selection.startRow)
                : rowIndex;

            this.setSelection(tab, paneIndex, anchor, rowIndex, anchor);
            this.dragSelection = {
                paneIndex,
                anchorRow: anchor
            };

            this.refreshSelectionVisuals();
        }

        handleGlobalMouseMove(event) {
            if (this.inlineEditor || !this.dragSelection || !this.isOpen()) {
                return;
            }

            const target = document.elementFromPoint(event.clientX, event.clientY);
            const cellEl = target?.closest?.('.difference-cell');
            if (!cellEl) {
                return;
            }

            const paneIndex = Number(cellEl.dataset.paneIndex);
            const rowIndex = Number(cellEl.dataset.rowIndex);
            if (Number.isNaN(paneIndex) || Number.isNaN(rowIndex) || paneIndex !== this.dragSelection.paneIndex) {
                return;
            }

            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            this.setSelection(tab, paneIndex, this.dragSelection.anchorRow, rowIndex, this.dragSelection.anchorRow);
            this.refreshSelectionVisuals();
        }

        handleGlobalMouseUp() {
            if (!this.dragSelection) {
                return;
            }

            this.dragSelection = null;
            this.updateToolbarState();
        }

        beginInlineEdit(paneIndex, rowIndex) {
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            if (!this.ensureWritableActiveTab('edit this file')) {
                return;
            }

            if (this.inlineEditor?.tabId === tab.id && this.inlineEditor.paneIndex === paneIndex && this.inlineEditor.rowIndex === rowIndex) {
                this.inlineEditor.textarea?.focus();
                this.inlineEditor.textarea?.select();
                return;
            }

            this.finishInlineEdit({ commit: true });

            const row = tab.rows[rowIndex];
            const cell = row?.cells?.[paneIndex];
            const cellEl = this.cellElements[rowIndex]?.[paneIndex];
            const codeScroller = cellEl?.querySelector('.difference-code-scroll');
            const codeEl = codeScroller?.querySelector('.difference-code');
            if (!row || !cell || !cellEl || !codeScroller || !codeEl) {
                return;
            }

            tab.focusPaneIndex = paneIndex;
            this.setSelection(tab, paneIndex, rowIndex, rowIndex, rowIndex, rowIndex);
            this.refreshSelectionVisuals();

            const textarea = document.createElement('textarea');
            textarea.className = 'difference-inline-editor';
            textarea.spellcheck = false;
            textarea.wrap = 'off';
            textarea.value = cell.missing ? '' : cell.text;

            const stopEvent = (event) => {
                event.stopPropagation();
            };

            textarea.addEventListener('mousedown', stopEvent);
            textarea.addEventListener('click', stopEvent);
            textarea.addEventListener('dblclick', stopEvent);
            textarea.addEventListener('keydown', (event) => {
                event.stopPropagation();

                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.finishInlineEdit({ commit: false });
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    this.finishInlineEdit({ commit: true });
                    return;
                }

                if (event.key === 'Tab') {
                    event.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    textarea.setRangeText('    ', start, end, 'end');
                }
            });
            textarea.addEventListener('blur', () => {
                if (this.inlineEditor?.textarea === textarea) {
                    this.finishInlineEdit({ commit: true });
                }
            });

            codeEl.hidden = true;
            codeScroller.classList.add('is-editing');
            cellEl.classList.add('is-editing');
            codeScroller.appendChild(textarea);

            this.inlineEditor = {
                tabId: tab.id,
                paneIndex,
                rowIndex,
                textarea,
                codeEl,
                codeScroller,
                cellEl,
                originalValue: textarea.value
            };

            textarea.scrollLeft = codeScroller.scrollLeft;
            textarea.focus();
            textarea.select();
        }

        finishInlineEdit({ commit }) {
            const editor = this.inlineEditor;
            if (!editor) {
                return false;
            }

            const tab = this.tabs.find(item => item.id === editor.tabId) || null;
            const nextValue = editor.textarea.value.replace(/\r\n/g, '\n');
            const originalValue = editor.originalValue.replace(/\r\n/g, '\n');

            editor.codeEl.hidden = false;
            editor.codeScroller.classList.remove('is-editing');
            editor.cellEl.classList.remove('is-editing');
            editor.textarea.remove();
            this.inlineEditor = null;

            if (!commit || !tab || nextValue === originalValue) {
                return false;
            }

            const replacementLines = nextValue.split('\n').map((text) => ({ text, hint: null }));
            this.applyReplacement(
                tab,
                editor.paneIndex,
                editor.rowIndex,
                editor.rowIndex,
                replacementLines,
                'Updated ' + tab.panes[editor.paneIndex].label + ' inline.'
            );
            return true;
        }

        syncTabScroll(source, target) {
            if (this.isSyncingTabScroll) {
                return;
            }

            this.isSyncingTabScroll = true;
            target.scrollLeft = source.scrollLeft;
            this.isSyncingTabScroll = false;
        }

        isOpen() {
            return this.modal.classList.contains('is-open');
        }

        async restoreSavedTabsOnce() {
            if (this.savedTabsRestored) {
                return;
            }

            this.savedTabsRestored = true;

            let descriptors = [];
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    descriptors = JSON.parse(raw);
                }
            } catch (err) {
                console.warn('Failed to restore difference tabs:', err);
            }

            for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
                try {
                    const tab = await this.loadTab(this.normalizeDescriptor(descriptor));
                    this.tabs.push(tab);
                } catch (err) {
                    console.warn('Failed to restore tab:', err);
                }
            }

            const activeKey = localStorage.getItem(ACTIVE_KEY);
            const activeTab = this.tabs.find(tab => this.getDescriptorKey(tab.descriptor) === activeKey);
            if (activeTab) {
                this.activeTabId = activeTab.id;
            } else if (this.tabs[0]) {
                this.activeTabId = this.tabs[0].id;
            }
        }

        normalizeDescriptor(descriptor) {
            const relativePath = descriptor.relativePath || descriptor.title || 'Untitled';
            const panes = Array.isArray(descriptor.panes)
                ? descriptor.panes
                    .filter(pane => pane && pane.path)
                    .map(pane => ({
                        path: pane.path,
                        label: pane.label || basename(pane.path)
                    }))
                : [];

            return {
                title: descriptor.title || basename(relativePath),
                relativePath,
                panes
            };
        }

        getDescriptorKey(descriptor) {
            return descriptor.panes.map(pane => pane.path).join('|');
        }

        async loadTab(descriptor, existingId = null) {
            const mode = this.getDescriptorMode(descriptor);
            const fileResults = await this.api.readFiles(descriptor.panes.map(pane => pane.path));
            const panes = descriptor.panes.map((pane, index) => {
                const result = fileResults[index] || {};
                const imagePane = mode === 'image';
                const textContent = imagePane ? '' : (result.content || '');

                return {
                    path: pane.path,
                    label: pane.label,
                    exists: Boolean(result.exists),
                    savedExists: Boolean(result.exists),
                    diskSnapshot: this.extractDiskSnapshot(result, pane.path),
                    diskChange: null,
                    error: result.error || '',
                    content: textContent,
                    savedContent: textContent,
                    kind: imagePane ? 'image' : 'text',
                    mimeType: imagePane ? (result.mimeType || this.getMimeTypeForFilePath(pane.path)) : '',
                    imageDataUrl: imagePane ? (result.dataUrl || '') : '',
                    dirty: false
                };
            });

            const tab = {
                id: existingId || this.createTabId(),
                title: descriptor.title,
                relativePath: descriptor.relativePath,
                mode,
                descriptor,
                panes,
                rows: [],
                hunks: [],
                dirty: false,
                focusPaneIndex: this.getDefaultFocusPaneIndex(panes),
                selection: null,
                history: this.createTabHistory()
            };

            if (mode === 'image') {
                return tab;
            }

            return window.DifferenceEngine.rebuildTab(tab);
        }

        createTabId() {
            return 'difference-tab-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        }

        getDefaultFocusPaneIndex(panes) {
            return 0;
        }

        cloneLineHints(lineHints) {
            if (!Array.isArray(lineHints)) {
                return null;
            }

            return lineHints.map((hint) => {
                if (!hint || typeof hint !== 'object') {
                    return hint ?? null;
                }

                return { ...hint };
            });
        }

        isPaneDirty(pane) {
            return (pane.content || '') !== (pane.savedContent || '') || Boolean(pane.exists) !== Boolean(pane.savedExists);
        }

        syncTabDirtyState(tab) {
            tab.panes.forEach((pane) => {
                pane.dirty = this.isPaneDirty(pane);
            });
        }

        createTabHistory() {
            return {
                undoStack: [],
                redoStack: []
            };
        }

        ensureTabHistory(tab) {
            if (!tab.history || !Array.isArray(tab.history.undoStack) || !Array.isArray(tab.history.redoStack)) {
                tab.history = this.createTabHistory();
            }

            return tab.history;
        }

        captureTabSnapshot(tab) {
            this.ensurePaneScrollState(tab);

            return {
                panes: tab.panes.map((pane) => ({
                    content: pane.content || '',
                    exists: Boolean(pane.exists),
                    error: pane.error || '',
                    lineHints: this.cloneLineHints(pane.lineHints)
                })),
                focusPaneIndex: tab.focusPaneIndex,
                selection: tab.selection ? { ...tab.selection } : null,
                paneScrollLefts: Array.isArray(tab.paneScrollLefts)
                    ? [...tab.paneScrollLefts]
                    : Array.from({ length: tab.panes.length }, () => 0)
            };
        }

        restoreTabSnapshot(tab, snapshot) {
            tab.panes = tab.panes.map((pane, paneIndex) => {
                const paneSnapshot = snapshot?.panes?.[paneIndex] || {};
                return {
                    ...pane,
                    content: paneSnapshot.content || '',
                    exists: Boolean(paneSnapshot.exists),
                    error: paneSnapshot.error || '',
                    lineHints: this.cloneLineHints(paneSnapshot.lineHints)
                };
            });

            tab.focusPaneIndex = clamp(
                Number.isInteger(snapshot?.focusPaneIndex) ? snapshot.focusPaneIndex : this.getDefaultFocusPaneIndex(tab.panes),
                0,
                Math.max(0, tab.panes.length - 1)
            );
            tab.selection = snapshot?.selection ? { ...snapshot.selection } : null;
            tab.paneScrollLefts = Array.isArray(snapshot?.paneScrollLefts)
                ? snapshot.paneScrollLefts.slice(0, tab.panes.length)
                : [];

            while (tab.paneScrollLefts.length < tab.panes.length) {
                tab.paneScrollLefts.push(0);
            }

            this.syncTabDirtyState(tab);
            if (this.isImageTab(tab)) {
                tab.rows = [];
                tab.hunks = [];
            } else {
                window.DifferenceEngine.rebuildTab(tab);
            }

            if (this.pendingRowReveal?.tabId === tab.id) {
                this.pendingRowReveal = null;
            }
        }

        pushUndoSnapshot(tab) {
            const history = this.ensureTabHistory(tab);
            history.undoStack.push(this.captureTabSnapshot(tab));
            history.redoStack.length = 0;
        }

        undoActiveTab() {
            this.finishInlineEdit({ commit: true });
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            if (!this.ensureWritableActiveTab('use undo')) {
                return;
            }

            const history = this.ensureTabHistory(tab);
            if (!history.undoStack.length) {
                this.setStatus('Nothing to undo.');
                return;
            }

            const wasDirty = tab.panes.some(pane => pane.dirty);
            history.redoStack.push(this.captureTabSnapshot(tab));
            const snapshot = history.undoStack.pop();
            this.restoreTabSnapshot(tab, snapshot);
            if (wasDirty !== tab.panes.some(pane => pane.dirty)) {
                this.renderTabs();
            }
            this.renderActiveTab();
            this.updateToolbarState();
        }

        redoActiveTab() {
            this.finishInlineEdit({ commit: true });
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            if (!this.ensureWritableActiveTab('use redo')) {
                return;
            }

            const history = this.ensureTabHistory(tab);
            if (!history.redoStack.length) {
                this.setStatus('Nothing to redo.');
                return;
            }

            const wasDirty = tab.panes.some(pane => pane.dirty);
            history.undoStack.push(this.captureTabSnapshot(tab));
            const snapshot = history.redoStack.pop();
            this.restoreTabSnapshot(tab, snapshot);
            if (wasDirty !== tab.panes.some(pane => pane.dirty)) {
                this.renderTabs();
            }
            this.renderActiveTab();
            this.updateToolbarState();
        }

        eventMatchesShortcutKey(event, { keys = [], codes = [], keyCodes = [] }) {
            const normalizedKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
            const normalizedCode = typeof event.code === 'string' ? event.code : '';
            const legacyKeyCode = Number.isInteger(event.keyCode)
                ? event.keyCode
                : (Number.isInteger(event.which) ? event.which : null);

            return (
                keys.includes(normalizedKey) ||
                codes.includes(normalizedCode) ||
                (legacyKeyCode != null && keyCodes.includes(legacyKeyCode))
            );
        }

        async openComparison(descriptor) {
            await this.restoreSavedTabsOnce();

            const normalized = this.normalizeDescriptor(descriptor);
            const descriptorKey = this.getDescriptorKey(normalized);
            const wasOpen = this.isOpen();
            let tab = this.tabs.find(existing => this.getDescriptorKey(existing.descriptor) === descriptorKey);
            const reusedExistingTab = Boolean(tab);

            if (!tab) {
                tab = await this.loadTab(normalized);
                this.tabs.push(tab);
            }

            if (!wasOpen) {
                tab.paneScrollLefts = Array.from({ length: tab.panes.length }, () => 0);
                this.pendingViewerOpenScrollReset = {
                    tabId: tab.id,
                    gridScrollLeft: 0
                };
            }

            this.activeTabId = tab.id;
            this.persistTabs();
            this.show();
            this.setStatus(
                (reusedExistingTab ? 'Reopened existing difference tab for ' : 'Opened difference tab for ') + normalized.relativePath + '.',
                true
            );
            this.render();
        }

        show() {
            if (!this.isOpen() && this.compareResults) {
                this.compareResultsPreviousHeight = this.compareResults.style.height;
                this.compareResults.style.height = `${this.compareResults.offsetHeight}px`;
                this.compareResults.classList.add('is-suspended');
                this.compareResults.setAttribute('aria-hidden', 'true');
            }

            this.modal.classList.add('is-open');
            document.body.style.overflow = 'hidden';
            this.scheduleDiskChangeCheck();

            if (this.hasAnyUnresolvedDiskChanges()) {
                this.showDiskChangeNotice(true);
            }
        }

        close() {
            if (this.tabs.some(tab => tab.panes.some(pane => pane.dirty))) {
                const proceed = confirm('There are unsaved changes in Difference. Close the popup anyway?');
                if (!proceed) {
                    return;
                }
            }

            this.modal.classList.remove('is-open');
            document.body.style.overflow = '';
            this.hideDiskChangeNotice();

            if (this.compareResults) {
                this.compareResults.classList.remove('is-suspended');
                this.compareResults.style.height = this.compareResultsPreviousHeight ?? '';
                this.compareResults.removeAttribute('aria-hidden');
                this.compareResultsPreviousHeight = null;
            }
        }

        persistTabs() {
            const descriptors = this.tabs.map(tab => ({
                title: tab.title,
                relativePath: tab.relativePath,
                panes: tab.descriptor.panes.map(pane => ({
                    path: pane.path,
                    label: pane.label
                }))
            }));

            localStorage.setItem(STORAGE_KEY, JSON.stringify(descriptors));

            const activeTab = this.getActiveTab();
            if (activeTab) {
                localStorage.setItem(ACTIVE_KEY, this.getDescriptorKey(activeTab.descriptor));
            } else {
                localStorage.removeItem(ACTIVE_KEY);
            }
        }

        getActiveTab() {
            return this.tabs.find(tab => tab.id === this.activeTabId) || null;
        }

        setStatus(message, keepSubtitle = false) {
            this.lastStatus = message;
            this.statusbarEl.textContent = message;
            if (keepSubtitle) {
                this.headerSubtitleEl.textContent = message;
            }
        }

        async closeTab(tabId) {
            const tab = this.tabs.find(item => item.id === tabId);
            if (!tab) return;

            if (tab.panes.some(pane => pane.dirty)) {
                const proceed = confirm('This tab has unsaved changes. Close it anyway?');
                if (!proceed) {
                    return;
                }
            }

            if (this.pendingRowReveal?.tabId === tabId) {
                this.pendingRowReveal = null;
            }

            if (this.inlineEditor?.tabId === tabId) {
                this.inlineEditor = null;
            }

            this.pendingDiskChangeNoticeItems = this.pendingDiskChangeNoticeItems
                .filter((item) => item.tab.id !== tabId);

            this.tabs = this.tabs.filter(item => item.id !== tabId);

            if (this.activeTabId === tabId) {
                this.activeTabId = this.tabs[0]?.id || null;
            }

            if (!this.hasAnyUnresolvedDiskChanges()) {
                this.hideDiskChangeNotice();
            } else if (this.diskChangeNoticeOpen) {
                this.diskChangeNoticeDirty = true;
                this.refreshDiskChangeNoticeList();
            }

            this.persistTabs();
            this.render();
        }

        async reloadActiveTab() {
            this.finishInlineEdit({ commit: true });
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            if (tab.panes.some(pane => pane.dirty)) {
                const proceed = confirm('Reloading will discard the unsaved changes in the current tab. Continue?');
                if (!proceed) {
                    return;
                }
            }

            const refreshed = await this.loadTab(tab.descriptor, tab.id);
            Object.assign(tab, refreshed);
            this.pendingDiskChangeNoticeItems = this.pendingDiskChangeNoticeItems
                .filter((item) => item.tab.id !== tab.id);
            this.pendingRowReveal = null;
            this.diskChangeNoticeDirty = true;
            if (this.diskChangeNoticeOpen && this.hasAnyUnresolvedDiskChanges()) {
                this.refreshDiskChangeNoticeList();
            } else if (!this.hasAnyUnresolvedDiskChanges()) {
                this.hideDiskChangeNotice();
            }
            this.setStatus('Reloaded ' + tab.relativePath + ' from disk.');
            this.render();
        }

        async savePane(tab, paneIndex) {
            this.finishInlineEdit({ commit: true });
            if (this.tabHasUnresolvedDiskChanges(tab)) {
                this.showDiskChangeNotice(true);
                this.setStatus('Resolve files changed on disk before saving.', true);
                return;
            }

            if (this.isImageTab(tab)) {
                this.setStatus('Image comparison is preview-only in this version.');
                return;
            }

            const pane = tab.panes[paneIndex];
            if (!pane || !pane.dirty) {
                return;
            }

            const result = await this.api.writeFile({
                path: pane.path,
                content: pane.content
            });

            pane.exists = true;
            pane.savedExists = true;
            pane.savedContent = pane.content;
            pane.diskSnapshot = this.extractDiskSnapshot(result?.diskSnapshot, pane.path);
            pane.diskChange = null;
            this.syncTabDirtyState(tab);
            window.DifferenceEngine.rebuildTab(tab);
            this.persistTabs();
            this.setStatus('Saved ' + pane.label + ' to ' + pane.path + '.');
        }

        async saveAllTabs() {
            this.finishInlineEdit({ commit: true });
            if (this.hasAnyUnresolvedDiskChanges()) {
                this.showDiskChangeNotice(true);
                this.setStatus('Resolve files changed on disk before using Save All.', true);
                return;
            }

            const dirtyPanes = [];

            this.tabs.forEach(tab => {
                tab.panes.forEach((pane, paneIndex) => {
                    if (pane.dirty) {
                        dirtyPanes.push({ tab, paneIndex });
                    }
                });
            });

            if (!dirtyPanes.length) {
                this.setStatus('There are no unsaved changes to save.');
                return;
            }

            for (const item of dirtyPanes) {
                await this.savePane(item.tab, item.paneIndex);
            }

            this.setStatus('Saved ' + dirtyPanes.length + ' modified file(s).', true);
            this.render();
        }

        scheduleDiskChangeCheck() {
            if (this.pendingDiskChangeCheckTimer) {
                clearTimeout(this.pendingDiskChangeCheckTimer);
                this.pendingDiskChangeCheckTimer = 0;
            }

            this.pendingDiskChangeCheckTimer = setTimeout(() => {
                this.pendingDiskChangeCheckTimer = 0;
                this.checkOpenTabsForDiskChanges().catch((err) => {
                    console.warn('Failed to check open tabs for disk changes:', err);
                });
            }, 120);
        }

        async checkOpenTabsForDiskChanges() {
            if (!this.tabs.length || !this.api.getFileStats) {
                return;
            }

            const paths = [];
            const seenPaths = new Set();
            this.tabs.forEach((tab) => {
                tab.panes.forEach((pane) => {
                    const filePath = String(pane?.path || '').trim();
                    if (!filePath || seenPaths.has(filePath)) {
                        return;
                    }

                    seenPaths.add(filePath);
                    paths.push(filePath);
                });
            });

            if (!paths.length) {
                return;
            }

            const stats = await this.api.getFileStats(paths);
            const statsByPath = new Map();
            (Array.isArray(stats) ? stats : []).forEach((item) => {
                statsByPath.set(String(item?.path || ''), this.extractDiskSnapshot(item, item?.path || ''));
            });

            const newNoticeItems = [];
            const affectedActiveTab = Boolean(
                this.inlineEditor &&
                this.tabs.some((tab) => tab.id === this.inlineEditor.tabId)
            );
            let shouldRender = false;

            this.tabs.forEach((tab) => {
                tab.panes.forEach((pane, paneIndex) => {
                    const latestSnapshot = statsByPath.get(String(pane.path || '')) || this.createDiskSnapshot(pane.path, false);

                    if (!this.diskSnapshotsEqual(pane.diskSnapshot, latestSnapshot)) {
                        if (!this.hasPaneDiskConflict(pane)) {
                            pane.diskChange = {
                                detectedAt: Date.now(),
                                diskSnapshot: latestSnapshot
                            };
                            newNoticeItems.push({
                                key: this.getPaneConflictKey(tab, paneIndex),
                                tab,
                                pane,
                                paneIndex
                            });
                            if (tab.id === this.activeTabId) {
                                shouldRender = true;
                            }
                        } else if (!this.diskSnapshotsEqual(pane.diskChange.diskSnapshot, latestSnapshot)) {
                            pane.diskChange.diskSnapshot = latestSnapshot;
                            shouldRender = true;
                        }

                        if (this.inlineEditor?.tabId === tab.id && this.inlineEditor.paneIndex === paneIndex) {
                            this.finishInlineEdit({ commit: true });
                        }
                    }
                });
            });

            if (newNoticeItems.length) {
                this.queueDiskChangeNotice(newNoticeItems);
                this.renderTabs();
                this.updateToolbarState();
            }

            if (shouldRender) {
                this.render();
                return;
            }

            if (affectedActiveTab) {
                this.refreshSelectionVisuals();
            }
        }

        async reloadPaneFromDisk(tab, paneIndex) {
            const pane = tab?.panes?.[paneIndex];
            if (!pane) {
                return;
            }

            this.finishInlineEdit({ commit: true });

            const [result] = await this.api.readFiles([pane.path]);
            const mode = this.isImageTab(tab) ? 'image' : 'text';
            const nextExists = Boolean(result?.exists);
            const nextContent = mode === 'image' ? '' : (result?.content || '');

            tab.panes[paneIndex] = {
                ...pane,
                exists: nextExists,
                savedExists: nextExists,
                diskSnapshot: this.extractDiskSnapshot(result, pane.path),
                diskChange: null,
                error: result?.error || '',
                content: nextContent,
                savedContent: nextContent,
                mimeType: mode === 'image' ? (result?.mimeType || this.getMimeTypeForFilePath(pane.path)) : '',
                imageDataUrl: mode === 'image' ? (result?.dataUrl || '') : '',
                lineHints: null
            };

            tab.selection = null;
            tab.history = this.createTabHistory();
            this.syncTabDirtyState(tab);

            if (this.isImageTab(tab)) {
                tab.rows = [];
                tab.hunks = [];
            } else {
                window.DifferenceEngine.rebuildTab(tab);
            }

            this.clearPaneDiskConflict(tab, paneIndex);
            this.persistTabs();
            this.setStatus('Reloaded ' + pane.label + ' from disk.', true);
            this.render();
        }

        async keepPaneCurrentVersion(tab, paneIndex) {
            const pane = tab?.panes?.[paneIndex];
            if (!pane || !pane.diskChange) {
                return;
            }

            this.finishInlineEdit({ commit: true });

            const [result] = await this.api.readFiles([pane.path]);
            pane.savedExists = Boolean(result?.exists);
            pane.savedContent = this.isImageTab(tab) ? '' : (result?.content || '');
            pane.diskSnapshot = this.extractDiskSnapshot(result, pane.path);
            pane.error = result?.error || '';
            this.clearPaneDiskConflict(tab, paneIndex);
            this.syncTabDirtyState(tab);
            this.persistTabs();
            this.setStatus('Kept the current viewer version for ' + pane.label + '.', true);
            this.render();
        }

        render() {
            this.renderTabs();
            this.renderActiveTab();
            this.updateToolbarState();
        }

        renderTabs() {
            this.tabsEl.innerHTML = '';

            this.tabs.forEach(tab => {
                const tabButton = document.createElement('div');
                tabButton.className = 'difference-tab' + (tab.id === this.activeTabId ? ' is-active' : '');
                tabButton.addEventListener('click', () => {
                    this.activeTabId = tab.id;
                    this.persistTabs();
                    this.render();
                });

                const meta = document.createElement('div');
                meta.className = 'difference-tab-meta';

                const title = document.createElement('div');
                title.className = 'difference-tab-title';
                title.textContent = tab.title;

                const pathEl = document.createElement('div');
                pathEl.className = 'difference-tab-path';
                pathEl.textContent = tab.relativePath;

                const badges = document.createElement('div');
                badges.className = 'difference-tab-badges';

                const paneBadge = document.createElement('span');
                paneBadge.className = 'difference-badge';
                paneBadge.textContent = tab.panes.length + ' file' + (tab.panes.length === 1 ? '' : 's');
                badges.appendChild(paneBadge);

                if (tab.panes.some(pane => pane.dirty)) {
                    const dirtyBadge = document.createElement('span');
                    dirtyBadge.className = 'difference-badge is-dirty';
                    dirtyBadge.textContent = 'Unsaved';
                    badges.appendChild(dirtyBadge);
                }

                if (this.tabHasUnresolvedDiskChanges(tab)) {
                    const diskBadge = document.createElement('span');
                    diskBadge.className = 'difference-badge is-warning';
                    diskBadge.textContent = 'Changed on disk';
                    badges.appendChild(diskBadge);
                }

                meta.appendChild(title);
                meta.appendChild(pathEl);
                meta.appendChild(badges);

                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'difference-tab-close';
                closeBtn.textContent = 'X';
                closeBtn.title = 'Close this tab';
                closeBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.closeTab(tab.id);
                });

                tabButton.appendChild(meta);
                tabButton.appendChild(closeBtn);
                this.tabsEl.appendChild(tabButton);
            });

            requestAnimationFrame(() => {
                this.tabScrollbarSpacerEl.style.width = this.tabsEl.scrollWidth + 'px';
                const activeButton = this.tabsEl.querySelector('.difference-tab.is-active');
                if (activeButton) {
                    activeButton.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
                }
            });
        }

        resetVisibleRowsState(tab) {
            this.rowElements = [];
            this.cellElements = [];
            this.codeScrollerElements = Array.from({ length: tab.panes.length }, () => []);
            this.codeContentElements = Array.from({ length: tab.panes.length }, () => []);
        }

        createRowElement(tab, row, rowIndex) {
            const rowEl = document.createElement('div');
            const rowChanged = row.cells.some(cell => cell?.changedLeft || cell?.changedRight || cell?.missing);
            rowEl.className = 'difference-row' +
                (this.hunkStartSet?.has(rowIndex) ? ' is-change-start' : '') +
                (rowChanged ? ' is-changed' : '');
            rowEl.style.gridTemplateColumns = this.activeTemplateColumns;
            this.cellElements[rowIndex] = [];

            row.cells.forEach((cell, paneIndex) => {
                const cellEl = document.createElement('div');
                cellEl.className = 'difference-cell';
                cellEl.dataset.rowIndex = String(rowIndex);
                cellEl.dataset.paneIndex = String(paneIndex);
                cellEl.style.minWidth = this.paneMinWidth + 'px';
                cellEl.style.maxWidth = this.paneMaxWidth + 'px';

                if (paneIndex === tab.focusPaneIndex) {
                    cellEl.classList.add('is-active-pane');
                }

                if (tab.selection && tab.selection.paneIndex === paneIndex && rowIndex >= tab.selection.startRow && rowIndex <= tab.selection.endRow) {
                    cellEl.classList.add('is-selected');
                }

                if (cell.changedLeft) {
                    cellEl.classList.add('is-changed-left');
                }

                if (cell.changedRight) {
                    cellEl.classList.add('is-changed-right');
                }

                if (cell.changedLeft || cell.changedRight || cell.missing) {
                    cellEl.classList.add('is-diff-row');
                }

                if (cell.missing) {
                    cellEl.classList.add('is-missing');
                }

                const gutter = document.createElement('div');
                gutter.className = 'difference-gutter';
                gutter.textContent = cell.lineNumber == null ? '' : String(cell.lineNumber);

                const codeScroller = document.createElement('div');
                codeScroller.className = 'difference-code-scroll';

                const code = document.createElement('div');
                code.className = 'difference-code' + (cell.missing ? ' is-placeholder' : '');
                this.renderCodeContent(code, row, paneIndex);

                cellEl.appendChild(gutter);
                codeScroller.appendChild(code);
                cellEl.appendChild(codeScroller);
                rowEl.appendChild(cellEl);
                this.cellElements[rowIndex][paneIndex] = cellEl;
                this.codeScrollerElements[paneIndex].push(codeScroller);
                this.codeContentElements[paneIndex].push(code);
            });

            this.rowElements[rowIndex] = rowEl;
            return rowEl;
        }

        renderVirtualRows(force = false) {
            const tab = this.getActiveTab();
            if (!tab || !this.rowsHostEl || !this.gridScroll || !tab.rows.length) {
                return;
            }

            const totalRows = tab.rows.length;
            const headerHeight = this.headersContainerEl?.offsetHeight || 0;
            const rowsTopOffset = this.rowsHostEl.offsetTop;
            const scrollbarHeight = this.scrollbarRowEl?.offsetHeight || 0;
            const currentTop = this.gridScroll.scrollTop;
            const viewportHeight = this.gridScroll.clientHeight;
            const relativeTop = Math.max(0, currentTop + headerHeight - rowsTopOffset);
            const relativeBottom = Math.max(
                relativeTop,
                currentTop + viewportHeight - scrollbarHeight - rowsTopOffset
            );
            const startRow = clamp(
                Math.floor(relativeTop / this.virtualRowHeight) - this.virtualRowOverscan,
                0,
                totalRows
            );
            const endRow = clamp(
                Math.ceil(relativeBottom / this.virtualRowHeight) + this.virtualRowOverscan,
                Math.max(startRow + 1, 1),
                totalRows
            );

            if (
                !force &&
                this.visibleRowRange &&
                this.visibleRowRange.tabId === tab.id &&
                this.visibleRowRange.startRow === startRow &&
                this.visibleRowRange.endRow === endRow
            ) {
                return;
            }

            this.visibleRowRange = {
                tabId: tab.id,
                startRow,
                endRow
            };

            this.resetVisibleRowsState(tab);

            const fragment = document.createDocumentFragment();
            const topSpacer = document.createElement('div');
            topSpacer.className = 'difference-row-spacer';
            topSpacer.style.height = `${startRow * this.virtualRowHeight}px`;
            fragment.appendChild(topSpacer);

            for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
                fragment.appendChild(this.createRowElement(tab, tab.rows[rowIndex], rowIndex));
            }

            const bottomSpacer = document.createElement('div');
            bottomSpacer.className = 'difference-row-spacer';
            bottomSpacer.style.height = `${Math.max(0, (totalRows - endRow) * this.virtualRowHeight)}px`;
            fragment.appendChild(bottomSpacer);

            this.rowsHostEl.replaceChildren(fragment);
            const measuredRowHeight = this.rowsHostEl.querySelector('.difference-row')?.offsetHeight || this.virtualRowHeight;
            if (Math.abs(measuredRowHeight - this.virtualRowHeight) > 0.5) {
                this.virtualRowHeight = measuredRowHeight;
                this.visibleRowRange = null;
                this.renderVirtualRows(true);
                return;
            }
            this.refreshPaneScrollbarMetrics(tab);
            this.restorePaneScrollPositions(tab);
        }

        rowHasPaneDiff(row, paneIndex) {
            const cell = row?.cells?.[paneIndex];
            return Boolean(cell && (cell.changedLeft || cell.changedRight || cell.missing));
        }

        getOverviewSegments(tab) {
            const segmentsByPane = Array.from({ length: tab.panes.length }, () => []);
            const openSegments = Array.from({ length: tab.panes.length }, () => null);

            tab.rows.forEach((row, rowIndex) => {
                tab.panes.forEach((_, paneIndex) => {
                    const changed = this.rowHasPaneDiff(row, paneIndex);
                    const cell = row?.cells?.[paneIndex];
                    const missing = Boolean(cell?.missing);
                    const openSegment = openSegments[paneIndex];

                    if (changed) {
                        if (openSegment) {
                            if (openSegment.missing !== missing) {
                                openSegment.end = rowIndex - 1;
                                segmentsByPane[paneIndex].push(openSegment);
                                openSegments[paneIndex] = {
                                    start: rowIndex,
                                    end: rowIndex,
                                    missing
                                };
                                return;
                            }

                            openSegment.end = rowIndex;
                        } else {
                            openSegments[paneIndex] = {
                                start: rowIndex,
                                end: rowIndex,
                                missing
                            };
                        }
                        return;
                    }

                    if (openSegment) {
                        segmentsByPane[paneIndex].push(openSegment);
                        openSegments[paneIndex] = null;
                    }
                });
            });

            openSegments.forEach((segment, paneIndex) => {
                if (segment) {
                    segmentsByPane[paneIndex].push(segment);
                }
            });

            return segmentsByPane;
        }

        setOverviewRangeStyle(element, startRow, endRow, totalRows, minPixels = 2) {
            const safeTotal = Math.max(totalRows, 1);
            const startRatio = clamp(startRow / safeTotal, 0, 1);
            const endRatio = clamp((endRow + 1) / safeTotal, startRatio, 1);
            const heightRatio = Math.max(0, endRatio - startRatio);

            element.style.top = (startRatio * 100).toFixed(4) + '%';
            element.style.height = `max(${minPixels}px, ${(heightRatio * 100).toFixed(4)}%)`;
        }

        createOverviewMarker(startRow, endRow, totalRows, className, minPixels = 2) {
            const marker = document.createElement('div');
            marker.className = className;
            this.setOverviewRangeStyle(marker, startRow, endRow, totalRows, minPixels);
            return marker;
        }

        createOverviewMap(tab) {
            const overview = document.createElement('div');
            overview.className = 'difference-overview';
            overview.style.setProperty('--difference-overview-width', clamp(84 + tab.panes.length * 6, 104, 220) + 'px');
            overview.title = 'File overview: click or drag to jump through the diff';
            overview.setAttribute('role', 'scrollbar');
            overview.setAttribute('aria-orientation', 'vertical');
            overview.setAttribute('aria-label', 'File overview');
            overview.setAttribute('aria-valuemin', '1');
            overview.setAttribute('aria-valuemax', String(Math.max(tab.rows.length, 1)));
            overview.tabIndex = 0;

            const track = document.createElement('div');
            track.className = 'difference-overview-track';

            const hunkLayer = document.createElement('div');
            hunkLayer.className = 'difference-overview-hunks';
            tab.hunks.forEach((hunk) => {
                hunkLayer.appendChild(this.createOverviewMarker(
                    hunk.start,
                    hunk.end,
                    tab.rows.length,
                    'difference-overview-hunk',
                    3
                ));
            });

            const lanes = document.createElement('div');
            lanes.className = 'difference-overview-lanes';
            lanes.style.gridTemplateColumns = `repeat(${Math.max(tab.panes.length, 1)}, minmax(4px, 1fr))`;

            const segmentsByPane = this.getOverviewSegments(tab);
            segmentsByPane.forEach((segments, paneIndex) => {
                const lane = document.createElement('div');
                lane.className = 'difference-overview-lane';
                lane.title = tab.panes[paneIndex]?.label || '';

                segments.forEach((segment) => {
                    lane.appendChild(this.createOverviewMarker(
                        segment.start,
                        segment.end,
                        tab.rows.length,
                        'difference-overview-change' + (segment.missing ? ' is-missing' : ''),
                        2
                    ));
                });

                lanes.appendChild(lane);
            });

            const selection = document.createElement('div');
            selection.className = 'difference-overview-selection';

            const viewport = document.createElement('div');
            viewport.className = 'difference-overview-viewport';

            track.appendChild(hunkLayer);
            track.appendChild(lanes);
            track.appendChild(selection);
            track.appendChild(viewport);
            overview.appendChild(track);

            track.addEventListener('pointerdown', (event) => this.handleOverviewPointerDown(event));
            track.addEventListener('pointermove', (event) => this.handleOverviewPointerMove(event));
            track.addEventListener('pointerup', (event) => this.handleOverviewPointerUp(event));
            track.addEventListener('pointercancel', (event) => this.handleOverviewPointerUp(event));
            overview.addEventListener('keydown', (event) => this.handleOverviewKeyDown(event));

            this.overviewEl = overview;
            this.overviewTrackEl = track;
            this.overviewViewportEl = viewport;
            this.overviewSelectionEl = selection;

            return overview;
        }

        getVisibleOverviewRatios(tab) {
            if (!this.gridScroll || !this.rowsHostEl || !tab?.rows?.length) {
                return { start: 0, end: 1, currentRow: 0 };
            }

            const totalRows = tab.rows.length;
            const headerHeight = this.headersContainerEl?.offsetHeight || 0;
            const rowsTopOffset = this.rowsHostEl.offsetTop;
            const scrollbarHeight = this.scrollbarRowEl?.offsetHeight || 0;
            const currentTop = this.gridScroll.scrollTop;
            const viewportHeight = this.gridScroll.clientHeight;
            const totalRowsHeight = Math.max(1, totalRows * this.virtualRowHeight);
            const visibleTop = clamp(currentTop + headerHeight - rowsTopOffset, 0, totalRowsHeight);
            const visibleBottom = clamp(
                currentTop + viewportHeight - scrollbarHeight - rowsTopOffset,
                visibleTop,
                totalRowsHeight
            );

            return {
                start: visibleTop / totalRowsHeight,
                end: visibleBottom / totalRowsHeight,
                currentRow: clamp(Math.round(visibleTop / this.virtualRowHeight) + 1, 1, totalRows)
            };
        }

        updateOverviewViewport() {
            const tab = this.getActiveTab();
            if (!tab || !this.overviewViewportEl || !this.overviewEl || !tab.rows.length) {
                return;
            }

            const ratios = this.getVisibleOverviewRatios(tab);
            const viewportRatio = Math.max(0, ratios.end - ratios.start);
            const trackHeight = this.overviewTrackEl?.clientHeight || 0;
            const scrollRange = this.gridScroll
                ? Math.max(0, this.gridScroll.scrollHeight - this.gridScroll.clientHeight)
                : 0;
            const scrollProgress = scrollRange > 0
                ? clamp(this.gridScroll.scrollTop / scrollRange, 0, 1)
                : 0;

            if (trackHeight > 0) {
                const rawViewportHeight = viewportRatio * trackHeight;
                const viewportHeight = Math.min(trackHeight, Math.max(6, rawViewportHeight));
                const viewportTravel = Math.max(0, trackHeight - viewportHeight);
                const viewportTop = scrollProgress * viewportTravel;

                this.overviewViewportEl.style.top = Math.round(viewportTop) + 'px';
                this.overviewViewportEl.style.height = Math.round(viewportHeight) + 'px';
                this.overviewViewportEl.style.transform = 'none';
            } else {
                this.overviewViewportEl.style.top = (scrollProgress * 100).toFixed(4) + '%';
                this.overviewViewportEl.style.height = `max(6px, ${(viewportRatio * 100).toFixed(4)}%)`;
                this.overviewViewportEl.style.transform = `translateY(-${(scrollProgress * 100).toFixed(4)}%)`;
            }

            this.overviewEl.setAttribute('aria-valuenow', String(ratios.currentRow));
            this.overviewEl.setAttribute('aria-valuetext', 'Row ' + ratios.currentRow + ' of ' + tab.rows.length);
        }

        updateOverviewSelection() {
            const tab = this.getActiveTab();
            const selection = tab?.selection || null;
            if (!tab || !this.overviewSelectionEl || !tab.rows.length || !selection) {
                if (this.overviewSelectionEl) {
                    this.overviewSelectionEl.hidden = true;
                }
                return;
            }

            this.overviewSelectionEl.hidden = false;
            this.setOverviewRangeStyle(
                this.overviewSelectionEl,
                selection.startRow,
                selection.endRow,
                tab.rows.length,
                4
            );
        }

        scrollOverviewToClientY(clientY) {
            const tab = this.getActiveTab();
            if (!tab || !this.overviewTrackEl || !tab.rows.length) {
                return;
            }

            const rect = this.overviewTrackEl.getBoundingClientRect();
            const ratio = rect.height > 0
                ? clamp((clientY - rect.top) / rect.height, 0, 1)
                : 0;
            const targetRow = clamp(Math.floor(ratio * tab.rows.length), 0, tab.rows.length - 1);
            this.scrollToRowCenter(targetRow);
            this.updateOverviewViewport();
        }

        scrollToRowCenter(rowIndex) {
            if (!this.gridScroll || !this.rowsHostEl) {
                return;
            }

            const viewportHeight = this.gridScroll.clientHeight;
            const headerHeight = this.headersContainerEl?.offsetHeight || 0;
            const scrollbarHeight = this.scrollbarRowEl?.offsetHeight || 0;
            const rowsTopOffset = this.rowsHostEl.offsetTop || 0;
            const rowHeight = this.virtualRowHeight;
            const visibleHeight = Math.max(rowHeight, viewportHeight - headerHeight - scrollbarHeight);
            const rowCenter = (rowIndex * rowHeight) + (rowHeight / 2);
            const nextTop = rowsTopOffset + rowCenter - headerHeight - (visibleHeight / 2);
            const maxTop = Math.max(0, this.gridScroll.scrollHeight - viewportHeight);
            const targetTop = clamp(Math.round(nextTop), 0, maxTop);

            this.gridScroll.scrollTop = targetTop;
            this.renderVirtualRows(true);
            this.centerRenderedRowIfPossible(rowIndex);
            this.updateOverviewViewport();
        }

        centerRenderedRowIfPossible(rowIndex) {
            const rowEl = this.rowElements[rowIndex];

            if (!this.gridScroll || !rowEl?.isConnected) {
                return;
            }

            const gridRect = this.gridScroll.getBoundingClientRect();
            const headerRect = this.headersContainerEl?.getBoundingClientRect();
            const scrollbarRect = this.scrollbarRowEl?.getBoundingClientRect();
            const rowRect = rowEl.getBoundingClientRect();
            const visibleTop = headerRect
                ? Math.max(gridRect.top, headerRect.bottom)
                : gridRect.top;
            const visibleBottom = scrollbarRect
                ? Math.min(gridRect.bottom, scrollbarRect.top)
                : gridRect.bottom;
            const visibleCenter = visibleTop + ((visibleBottom - visibleTop) / 2);
            const rowCenter = rowRect.top + (rowRect.height / 2);
            const maxTop = Math.max(0, this.gridScroll.scrollHeight - this.gridScroll.clientHeight);
            const nextTop = clamp(
                Math.round(this.gridScroll.scrollTop + (rowCenter - visibleCenter)),
                0,
                maxTop
            );

            if (Math.abs(nextTop - this.gridScroll.scrollTop) > 1) {
                this.gridScroll.scrollTop = nextTop;
                this.renderVirtualRows(true);
            }
        }

        handleOverviewPointerDown(event) {
            if (event.button !== 0) {
                return;
            }

            event.preventDefault();
            this.finishInlineEdit({ commit: true });
            this.isDraggingOverview = true;
            this.overviewTrackEl?.setPointerCapture?.(event.pointerId);
            this.scrollOverviewToClientY(event.clientY);
        }

        handleOverviewPointerMove(event) {
            if (!this.isDraggingOverview) {
                return;
            }

            event.preventDefault();
            this.scrollOverviewToClientY(event.clientY);
        }

        handleOverviewPointerUp(event) {
            if (!this.isDraggingOverview) {
                return;
            }

            this.isDraggingOverview = false;
            this.overviewTrackEl?.releasePointerCapture?.(event.pointerId);
        }

        handleOverviewKeyDown(event) {
            if (!this.gridScroll) {
                return;
            }

            if (event.key === 'Home') {
                event.preventDefault();
                this.scrollToRow(0, { behavior: 'auto', block: 'center' });
            } else if (event.key === 'End') {
                const tab = this.getActiveTab();
                if (!tab?.rows?.length) {
                    return;
                }
                event.preventDefault();
                this.scrollToRow(tab.rows.length - 1, { behavior: 'auto', block: 'center' });
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.navigateHunk(-1);
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.navigateHunk(1);
            }
        }

        handleGridScroll() {
            this.renderVirtualRows();
            this.updateOverviewViewport();
        }

        createImagePane(tab, pane, paneIndex) {
            const paneEl = document.createElement('div');
            paneEl.className = 'difference-image-pane' + (paneIndex === tab.focusPaneIndex ? ' is-active' : '');
            paneEl.style.minWidth = this.paneMinWidth + 'px';
            paneEl.style.maxWidth = this.paneMaxWidth + 'px';
            paneEl.addEventListener('click', () => {
                if (tab.focusPaneIndex === paneIndex) {
                    return;
                }

                tab.focusPaneIndex = paneIndex;
                this.render();
            });

            const viewport = document.createElement('div');
            viewport.className = 'difference-image-viewport';

            const meta = document.createElement('div');
            meta.className = 'difference-image-meta';

            if (pane.error) {
                const placeholder = document.createElement('div');
                placeholder.className = 'difference-image-placeholder';

                const title = document.createElement('div');
                title.className = 'difference-image-placeholder-title';
                title.textContent = 'Unable to load image';

                const detail = document.createElement('div');
                detail.className = 'difference-image-placeholder-detail';
                detail.textContent = pane.error;

                placeholder.appendChild(title);
                placeholder.appendChild(detail);
                viewport.appendChild(placeholder);
                meta.textContent = 'Load error';
            } else if (!pane.exists || !pane.imageDataUrl) {
                const placeholder = document.createElement('div');
                placeholder.className = 'difference-image-placeholder';

                const title = document.createElement('div');
                title.className = 'difference-image-placeholder-title';
                title.textContent = 'Missing on disk';

                const detail = document.createElement('div');
                detail.className = 'difference-image-placeholder-detail';
                detail.textContent = 'This target does not have the image file yet.';

                placeholder.appendChild(title);
                placeholder.appendChild(detail);
                viewport.appendChild(placeholder);
                meta.textContent = 'No image available';
            } else {
                const frame = document.createElement('div');
                frame.className = 'difference-image-frame';

                const image = document.createElement('img');
                image.className = 'difference-image';
                image.src = pane.imageDataUrl;
                image.alt = basename(pane.path);
                image.decoding = 'async';
                image.addEventListener('load', () => {
                    const typeLabel = (pane.mimeType || this.getMimeTypeForFilePath(pane.path) || 'image')
                        .replace(/^image\//, '')
                        .toUpperCase();
                    meta.textContent = `${typeLabel} ${image.naturalWidth}x${image.naturalHeight}`;
                });

                frame.appendChild(image);
                viewport.appendChild(frame);
                meta.textContent = (pane.mimeType || this.getMimeTypeForFilePath(pane.path) || 'image')
                    .replace(/^image\//, '')
                    .toUpperCase();
            }

            paneEl.appendChild(viewport);
            paneEl.appendChild(meta);
            return paneEl;
        }

        getDiskChangeOverlayTitle(tab, pane) {
            if (!this.isImageTab(tab) && pane.dirty) {
                return 'This file changed on disk and also has unsaved changes here.';
            }

            return 'This file changed on disk.';
        }

        getDiskChangeOverlayDetail(tab, pane) {
            if (!this.isImageTab(tab) && pane.dirty) {
                return 'Reloading will discard the edits currently held in Difference. Keeping the current version will preserve the in-app content and mark it as newer than the disk copy.';
            }

            if (this.isImageTab(tab)) {
                return 'Reload to show the latest image from disk, or keep the current preview snapshot for now.';
            }

            return 'Reload to refresh from disk, or keep the current version and continue from the snapshot that is already open here.';
        }

        createConflictOverlayCell(tab, pane, paneIndex) {
            const cell = document.createElement('div');
            cell.className = 'difference-conflict-overlay-cell';
            cell.style.minWidth = this.paneMinWidth + 'px';
            cell.style.maxWidth = this.paneMaxWidth + 'px';

            if (!this.hasPaneDiskConflict(pane)) {
                return cell;
            }

            const overlay = document.createElement('div');
            overlay.className = 'difference-conflict-overlay';

            const card = document.createElement('div');
            card.className = 'difference-conflict-card';

            const title = document.createElement('div');
            title.className = 'difference-conflict-title';
            title.textContent = this.getDiskChangeOverlayTitle(tab, pane);

            const detail = document.createElement('div');
            detail.className = 'difference-conflict-detail';
            detail.textContent = this.getDiskChangeOverlayDetail(tab, pane);

            const actions = document.createElement('div');
            actions.className = 'difference-conflict-actions';

            const reloadBtn = this.createActionButton({
                className: 'difference-header-btn',
                label: 'Reload from disk',
                title: 'Reload this file from disk and clear the changed-on-disk warning',
                onClick: () => {
                    this.reloadPaneFromDisk(tab, paneIndex).catch((err) => {
                        this.setStatus('Reload failed: ' + err.message);
                    });
                }
            });

            const keepBtn = this.createActionButton({
                className: 'difference-header-btn',
                label: 'Keep current version',
                title: 'Keep the version currently open in Difference and treat the disk copy as outdated',
                onClick: () => {
                    this.keepPaneCurrentVersion(tab, paneIndex).catch((err) => {
                        this.setStatus('Keep current version failed: ' + err.message);
                    });
                }
            });

            actions.appendChild(reloadBtn);
            actions.appendChild(keepBtn);
            card.appendChild(title);
            card.appendChild(detail);
            card.appendChild(actions);
            overlay.appendChild(card);
            cell.appendChild(overlay);
            return cell;
        }

        createConflictOverlayLayer(tab, templateColumns) {
            if (!this.tabHasUnresolvedDiskChanges(tab)) {
                return null;
            }

            const layer = document.createElement('div');
            layer.className = 'difference-conflict-layer';
            layer.style.gridTemplateColumns = templateColumns;

            tab.panes.forEach((pane, paneIndex) => {
                layer.appendChild(this.createConflictOverlayCell(tab, pane, paneIndex));
            });

            return layer;
        }

        renderImageTab(tab, previousTop, previousLeft, shouldResetViewerOpenScroll) {
            const compare = document.createElement('div');
            compare.className = 'difference-compare difference-compare--image';

            const templateColumns = this.getPaneTemplateColumns(tab);

            const gridScroll = document.createElement('div');
            gridScroll.className = 'difference-grid-scroll difference-grid-scroll--image';
            gridScroll.addEventListener('scroll', () => this.handleGridScroll());

            const grid = document.createElement('div');
            grid.className = 'difference-grid difference-grid--image';

            const headers = document.createElement('div');
            headers.className = 'difference-pane-headers';
            headers.style.gridTemplateColumns = templateColumns;
            tab.panes.forEach((pane, paneIndex) => {
                headers.appendChild(this.createPaneHeader(tab, pane, paneIndex));
            });
            grid.appendChild(headers);
            this.headersContainerEl = headers;

            const panesRow = document.createElement('div');
            panesRow.className = 'difference-image-row';
            panesRow.style.gridTemplateColumns = templateColumns;

            tab.panes.forEach((pane, paneIndex) => {
                panesRow.appendChild(this.createImagePane(tab, pane, paneIndex));
            });

            grid.appendChild(panesRow);
            const conflictLayer = this.createConflictOverlayLayer(tab, templateColumns);
            if (conflictLayer) {
                grid.appendChild(conflictLayer);
            }
            gridScroll.appendChild(grid);
            compare.appendChild(gridScroll);
            this.bodyEl.appendChild(compare);

            this.gridScroll = gridScroll;
            this.gridEl = grid;
            this.activeTemplateColumns = templateColumns;
            this.activeRenderedTabId = tab.id;

            requestAnimationFrame(() => {
                if (this.gridScroll) {
                    this.gridScroll.scrollTop = previousTop;
                    this.gridScroll.scrollLeft = previousLeft;
                }
            });

            if (shouldResetViewerOpenScroll) {
                this.pendingViewerOpenScrollReset = null;
            }

            this.updateStatusForTab(tab);
            this.refreshSelectionVisuals();
        }

        renderActiveTab() {
            if (this.inlineEditor) {
                this.inlineEditor = null;
            }
            const tab = this.getActiveTab();
            let previousTop = this.gridScroll ? this.gridScroll.scrollTop : 0;
            let previousLeft = this.gridScroll ? this.gridScroll.scrollLeft : 0;
            const shouldResetViewerOpenScroll = Boolean(
                tab &&
                this.pendingViewerOpenScrollReset &&
                this.pendingViewerOpenScrollReset.tabId === tab.id
            );

            if (shouldResetViewerOpenScroll) {
                previousLeft = this.pendingViewerOpenScrollReset.gridScrollLeft || 0;
            }

            this.bodyEl.innerHTML = '';
            this.gridScroll = null;
            this.gridEl = null;
            this.rowsHostEl = null;
            this.headersContainerEl = null;
            this.scrollbarRowEl = null;
            this.activeTemplateColumns = '';
            this.activeRenderedTabId = null;
            this.visibleRowRange = null;
            this.hunkStartSet = null;
            this.rowElements = [];
            this.cellElements = [];
            this.headerElements = [];
            this.codeScrollerElements = [];
            this.codeContentElements = [];
            this.paneScrollbarElements = [];
            this.paneScrollbarSpacerElements = [];
            this.overviewEl = null;
            this.overviewTrackEl = null;
            this.overviewViewportEl = null;
            this.overviewSelectionEl = null;
            this.isDraggingOverview = false;

            if (!tab) {
                this.headerTitleEl.textContent = 'Difference';
                this.headerSubtitleEl.textContent = 'No compare tabs are open.';

                const empty = document.createElement('div');
                empty.className = 'difference-empty';
                empty.textContent = 'Open a Difference tab from the file list to compare, merge and save files here.';
                this.bodyEl.appendChild(empty);
                return;
            }

            this.headerTitleEl.textContent = tab.title;
            this.headerSubtitleEl.textContent = tab.relativePath;
            this.ensurePaneScrollState(tab);
            const pendingRowReveal = this.pendingRowReveal?.tabId === tab.id
                ? this.pendingRowReveal
                : null;

            if (this.isImageTab(tab)) {
                this.renderImageTab(tab, previousTop, previousLeft, shouldResetViewerOpenScroll);
                return;
            }

            const compare = document.createElement('div');
            compare.className = 'difference-compare';

            const templateColumns = this.getPaneTemplateColumns(tab);

            const gridScroll = document.createElement('div');
            gridScroll.className = 'difference-grid-scroll';
            gridScroll.addEventListener('scroll', () => this.handleGridScroll());

            const grid = document.createElement('div');
            grid.className = 'difference-grid';
            grid.addEventListener('mousedown', (event) => this.handleGridMouseDown(event));
            grid.addEventListener('dblclick', (event) => this.handleGridDoubleClick(event));

            const headers = document.createElement('div');
            headers.className = 'difference-pane-headers';
            headers.style.gridTemplateColumns = templateColumns;

            tab.panes.forEach((pane, paneIndex) => {
                headers.appendChild(this.createPaneHeader(tab, pane, paneIndex));
            });

            grid.appendChild(headers);
            this.headersContainerEl = headers;

            if (!tab.rows.length) {
                const empty = document.createElement('div');
                empty.className = 'difference-empty';
                empty.textContent = 'All compared files are empty.';
                grid.appendChild(empty);
            } else {
                this.hunkStartSet = new Set(tab.hunks.map(hunk => hunk.start));
                const rowsHost = document.createElement('div');
                rowsHost.className = 'difference-rows-host';
                grid.appendChild(rowsHost);
                this.rowsHostEl = rowsHost;

                const scrollbarRow = document.createElement('div');
                scrollbarRow.className = 'difference-pane-scrollbars';
                scrollbarRow.style.gridTemplateColumns = templateColumns;

                tab.panes.forEach((_, paneIndex) => {
                    const scrollbarCell = document.createElement('div');
                    scrollbarCell.className = 'difference-pane-scrollbar-cell';
                    scrollbarCell.style.minWidth = this.paneMinWidth + 'px';
                    scrollbarCell.style.maxWidth = this.paneMaxWidth + 'px';

                    const scrollbar = document.createElement('div');
                    scrollbar.className = 'difference-pane-scrollbar';
                    scrollbar.addEventListener('scroll', () => this.syncPaneScroll(paneIndex, scrollbar.scrollLeft, scrollbar));

                    const spacer = document.createElement('div');
                    spacer.className = 'difference-pane-scrollbar-spacer';

                    scrollbar.appendChild(spacer);
                    scrollbarCell.appendChild(scrollbar);
                    scrollbarRow.appendChild(scrollbarCell);
                    this.paneScrollbarElements[paneIndex] = scrollbar;
                    this.paneScrollbarSpacerElements[paneIndex] = spacer;
                });

                grid.appendChild(scrollbarRow);
                this.scrollbarRowEl = scrollbarRow;
            }

            const conflictLayer = this.createConflictOverlayLayer(tab, templateColumns);
            if (conflictLayer) {
                grid.appendChild(conflictLayer);
            }

            gridScroll.appendChild(grid);
            compare.appendChild(gridScroll);

            if (tab.rows.length) {
                compare.appendChild(this.createOverviewMap(tab));
            }

            this.bodyEl.appendChild(compare);

            this.gridScroll = gridScroll;
            this.gridEl = grid;
            this.activeTemplateColumns = templateColumns;
            this.activeRenderedTabId = tab.id;
            this.renderVirtualRows(true);
            if (this.gridScroll) {
                this.gridScroll.scrollTop = previousTop;
                this.gridScroll.scrollLeft = previousLeft;
            }
            this.updateOverviewViewport();
            this.updateOverviewSelection();
            this.renderVirtualRows(true);
            requestAnimationFrame(() => {
                if (this.gridScroll) {
                    this.gridScroll.scrollTop = previousTop;
                    this.gridScroll.scrollLeft = previousLeft;
                    this.renderVirtualRows(true);
                    this.updateOverviewViewport();
                    this.updateOverviewSelection();
                }
                if (pendingRowReveal) {
                    this.pendingRowReveal = null;
                    this.scrollToRow(pendingRowReveal.rowIndex, pendingRowReveal.options);
                    this.renderVirtualRows(true);
                    this.updateOverviewViewport();
                    this.updateOverviewSelection();
                }
            });
            if (shouldResetViewerOpenScroll) {
                this.pendingViewerOpenScrollReset = null;
            }

            this.updateStatusForTab(tab);
            this.refreshSelectionVisuals();
        }

        refreshPaneScrollbarMetrics(tab) {
            this.ensurePaneScrollState(tab);
            const globalMaxCodeColumns = Math.max(
                1,
                ...tab.rows.flatMap((row) => row.cells.map((cell) => {
                    if (!cell) {
                        return 0;
                    }

                    if (cell.missing) {
                        return 'Missing in this file'.length;
                    }

                    return Math.max(1, (cell.text || '').length);
                }))
            );
            const globalCodeWidth = `${globalMaxCodeColumns}ch`;
            const scrollbarWidth = `calc(${globalMaxCodeColumns}ch + ${LINE_GUTTER_WIDTH}px)`;

            this.codeContentElements.forEach((codes) => {
                (codes || []).forEach((code) => {
                    code.style.width = globalCodeWidth;
                });
            });

            this.paneScrollbarSpacerElements.forEach((spacer) => {
                if (spacer) {
                    spacer.style.width = scrollbarWidth;
                }
            });
        }

        restorePaneScrollPositions(tab) {
            this.ensurePaneScrollState(tab);
            this.codeScrollerElements.forEach((scrollers, paneIndex) => {
                const targetScrollLeft = tab.paneScrollLefts[paneIndex] || 0;
                (scrollers || []).forEach((scroller) => {
                    if (scroller.scrollLeft !== targetScrollLeft) {
                        scroller.scrollLeft = targetScrollLeft;
                    }
                });

                const paneScrollbar = this.paneScrollbarElements[paneIndex];
                if (paneScrollbar && paneScrollbar.scrollLeft !== targetScrollLeft) {
                    paneScrollbar.scrollLeft = targetScrollLeft;
                }
            });
        }

        applyPaneScrollPosition(paneIndex, nextScrollLeft, sourceScroller = null) {
            const scrollers = this.codeScrollerElements[paneIndex] || [];
            scrollers.forEach((scroller) => {
                if (scroller !== sourceScroller && scroller.scrollLeft !== nextScrollLeft) {
                    scroller.scrollLeft = nextScrollLeft;
                }
            });

            const paneScrollbar = this.paneScrollbarElements[paneIndex];
            if (paneScrollbar && paneScrollbar !== sourceScroller && paneScrollbar.scrollLeft !== nextScrollLeft) {
                paneScrollbar.scrollLeft = nextScrollLeft;
            }
        }

        flushPendingPaneScrolls() {
            this.pendingPaneScrollFrame = 0;
            this.isSyncingPaneScroll = true;

            this.pendingPaneScrollUpdates.forEach((update, paneIndex) => {
                this.applyPaneScrollPosition(paneIndex, update.scrollLeft, update.sourceScroller);
            });

            this.pendingPaneScrollUpdates.clear();
            this.isSyncingPaneScroll = false;
        }

        syncPaneScroll(paneIndex, nextScrollLeft, sourceScroller = null) {
            const tab = this.getActiveTab();
            if (!tab || this.isSyncingPaneScroll) {
                return;
            }

            this.ensurePaneScrollState(tab);
            tab.paneScrollLefts = Array.from({ length: tab.panes.length }, () => nextScrollLeft);

            tab.paneScrollLefts.forEach((scrollLeft, targetPaneIndex) => {
                this.pendingPaneScrollUpdates.set(targetPaneIndex, {
                    scrollLeft,
                    sourceScroller
                });
            });

            if (!this.pendingPaneScrollFrame) {
                this.pendingPaneScrollFrame = requestAnimationFrame(() => this.flushPendingPaneScrolls());
            }
        }

        updateStatusForTab(tab) {
            const activePane = tab.panes[tab.focusPaneIndex];
            const conflictCount = tab.panes.filter((pane) => this.hasPaneDiskConflict(pane)).length;
            if (this.isImageTab(tab)) {
                const availableCount = tab.panes.filter((pane) => pane.exists && !pane.error).length;
                const missingCount = tab.panes.filter((pane) => !pane.exists).length;
                const errorCount = tab.panes.filter((pane) => Boolean(pane.error)).length;
                const summaryParts = [
                    'Active: ' + (activePane?.label || 'n/a'),
                    `${availableCount} image preview${availableCount === 1 ? '' : 's'}`
                ];

                if (missingCount) {
                    summaryParts.push(`${missingCount} missing`);
                }

                if (errorCount) {
                    summaryParts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
                }

                if (conflictCount) {
                    summaryParts.push(`${conflictCount} changed on disk`);
                }

                this.setStatus(summaryParts.join(' | '));
                return;
            }

            const selection = tab.selection
                ? 'Selection: rows ' + (tab.selection.startRow + 1) + '-' + (tab.selection.endRow + 1)
                : 'Selection: none';
            const hunks = tab.hunks.length + ' change hunk' + (tab.hunks.length === 1 ? '' : 's');
            const dirtyCount = tab.panes.filter(pane => pane.dirty).length;
            const statusParts = [
                'Active: ' + (activePane?.label || 'n/a'),
                selection,
                hunks,
                dirtyCount + ' dirty file' + (dirtyCount === 1 ? '' : 's')
            ];

            if (conflictCount) {
                statusParts.push(conflictCount + ' changed on disk');
            }

            this.setStatus(statusParts.join(' | '));
        }

        updateToolbarState() {
            const tab = this.getActiveTab();
            const hasSelection = Boolean(tab?.selection);
            const dirtyTabs = this.tabs.some(item => item.panes.some(pane => pane.dirty));
            const imageTab = this.isImageTab(tab);
            const lockedTab = this.tabHasUnresolvedDiskChanges(tab);
            const anyLockedTabs = this.hasAnyUnresolvedDiskChanges();

            this.toggleDisabled(this.saveAllBtn, !dirtyTabs || anyLockedTabs);
            this.toggleDisabled(this.reloadBtn, !tab);
            this.toggleDisabled(this.prevHunkBtn, !tab || imageTab || !tab.hunks.length);
            this.toggleDisabled(this.nextHunkBtn, !tab || imageTab || !tab.hunks.length);
            this.toggleDisabled(this.copySelectionLeftBtn, imageTab || lockedTab || !this.canCopySelectionToNeighbor(-1));
            this.toggleDisabled(this.copySelectionRightBtn, imageTab || lockedTab || !this.canCopySelectionToNeighbor(1));
            this.toggleDisabled(this.copyLeftIntoSelectionBtn, imageTab || lockedTab || !this.canCopyNeighborIntoSelection(-1));
            this.toggleDisabled(this.copyRightIntoSelectionBtn, imageTab || lockedTab || !this.canCopyNeighborIntoSelection(1));
            this.toggleDisabled(this.mergeLeftRightBtn, imageTab || lockedTab || !hasSelection || !tab || tab.focusPaneIndex <= 0 || tab.focusPaneIndex >= tab.panes.length - 1);
            this.toggleDisabled(this.mergeRightLeftBtn, imageTab || lockedTab || !hasSelection || !tab || tab.focusPaneIndex <= 0 || tab.focusPaneIndex >= tab.panes.length - 1);
        }

        toggleDisabled(element, disabled) {
            element.classList.toggle('is-disabled', Boolean(disabled));
        }

        handleRowClick(paneIndex, rowIndex, event) {
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            tab.focusPaneIndex = paneIndex;

            if (event.shiftKey && tab.selection && tab.selection.paneIndex === paneIndex) {
                const anchor = tab.selection.anchorRow ?? tab.selection.startRow;
                tab.selection = {
                    paneIndex,
                    startRow: Math.min(anchor, rowIndex),
                    endRow: Math.max(anchor, rowIndex),
                    anchorRow: anchor,
                    activeRow: rowIndex
                };
            } else {
                tab.selection = {
                    paneIndex,
                    startRow: rowIndex,
                    endRow: rowIndex,
                    anchorRow: rowIndex,
                    activeRow: rowIndex
                };
            }

            this.render();
        }

        getSelection() {
            const tab = this.getActiveTab();
            if (!tab || !tab.selection) {
                return null;
            }

            return {
                tab,
                paneIndex: tab.selection.paneIndex,
                startRow: Math.min(tab.selection.startRow, tab.selection.endRow),
                endRow: Math.max(tab.selection.startRow, tab.selection.endRow)
            };
        }

        getPreviousMeaningfulLine(lines, startIndex) {
            return window.DifferenceTransfer.getPreviousMeaningfulLine(lines, startIndex);
        }

        getNextMeaningfulLine(lines, startIndex) {
            return window.DifferenceTransfer.getNextMeaningfulLine(lines, startIndex);
        }

        getRunInfo(lines, lineIndex) {
            return window.DifferenceTransfer.getRunInfo(lines, lineIndex);
        }

        buildTransferItem(tab, sourcePaneIndex, lineIndex) {
            return window.DifferenceTransfer.buildTransferItem(tab, sourcePaneIndex, lineIndex);
        }

        buildTransferItemsFromLineRange(tab, sourcePaneIndex, startLineIndex, endLineIndexExclusive) {
            return window.DifferenceTransfer.buildTransferItemsFromLineRange(
                tab,
                sourcePaneIndex,
                startLineIndex,
                endLineIndexExclusive
            );
        }

        getTransferLinesFromPane(tab, sourcePaneIndex, targetPaneIndex, startRow, endRow) {
            return window.DifferenceTransfer.getTransferLinesFromPane(
                tab,
                sourcePaneIndex,
                targetPaneIndex,
                startRow,
                endRow
            );
        }

        canCopySelectionToNeighbor(direction) {
            const selection = this.getSelection();
            if (!selection) {
                return false;
            }

            if (this.tabHasUnresolvedDiskChanges(selection.tab)) {
                return false;
            }

            const targetPaneIndex = selection.paneIndex + direction;
            if (targetPaneIndex < 0 || targetPaneIndex >= selection.tab.panes.length) {
                return false;
            }

            return window.DifferenceEngine.selectionHasContent(selection.tab.rows, selection.paneIndex, selection.startRow, selection.endRow);
        }

        canCopyNeighborIntoSelection(direction) {
            const selection = this.getSelection();
            if (!selection) {
                return false;
            }

            if (this.tabHasUnresolvedDiskChanges(selection.tab)) {
                return false;
            }

            const sourcePaneIndex = selection.paneIndex + direction;
            if (sourcePaneIndex < 0 || sourcePaneIndex >= selection.tab.panes.length) {
                return false;
            }

            return window.DifferenceEngine.selectionHasContent(selection.tab.rows, sourcePaneIndex, selection.startRow, selection.endRow);
        }

        canDeleteSelection() {
            const selection = this.getSelection();
            if (!selection) {
                return false;
            }

            if (this.tabHasUnresolvedDiskChanges(selection.tab)) {
                return false;
            }

            return window.DifferenceEngine.selectionHasContent(
                selection.tab.rows,
                selection.paneIndex,
                selection.startRow,
                selection.endRow
            );
        }

        setTransientSelectionFlash(tabId, paneIndex, startRow, endRow, durationMs = 220) {
            if (this.transientSelectionFlashTimer) {
                clearTimeout(this.transientSelectionFlashTimer);
                this.transientSelectionFlashTimer = 0;
            }

            this.transientSelectionFlash = null;
            this.refreshSelectionVisuals();

            this.transientSelectionFlash = {
                tabId,
                paneIndex,
                startRow,
                endRow
            };
            this.refreshSelectionVisuals();

            this.transientSelectionFlashTimer = setTimeout(() => {
                this.transientSelectionFlash = null;
                this.transientSelectionFlashTimer = 0;
                this.refreshSelectionVisuals();
            }, durationMs);
        }

        applyReplacement(tab, paneIndex, startRow, endRow, replacementLines, description, options = {}) {
            if (this.tabHasUnresolvedDiskChanges(tab)) {
                this.showDiskChangeNotice(true);
                this.setStatus('Resolve files changed on disk before editing this comparison.', true);
                return;
            }

            const wasDirty = tab.panes.some(pane => pane.dirty);
            this.pushUndoSnapshot(tab);
            const currentPane = tab.panes[paneIndex];
            tab.panes[paneIndex] = {
                ...window.DifferenceEngine.replacePaneSelection(tab, paneIndex, startRow, endRow, replacementLines),
                savedContent: currentPane.savedContent || '',
                savedExists: Boolean(currentPane.savedExists)
            };
            tab.focusPaneIndex = clamp(paneIndex, 0, Math.max(0, tab.panes.length - 1));
            this.syncTabDirtyState(tab);
            window.DifferenceEngine.rebuildTab(tab);

            if (tab.rows.length) {
                const maxRow = Math.max(tab.rows.length - 1, 0);
                const nextStart = clamp(startRow, 0, maxRow);
                const nextEnd = clamp(startRow + Math.max(replacementLines.length - 1, 0), nextStart, maxRow);

                tab.selection = {
                    paneIndex,
                    startRow: nextStart,
                    endRow: nextEnd,
                    anchorRow: nextStart,
                    activeRow: nextEnd
                };
            } else {
                tab.selection = null;
            }

            this.persistTabs();
            this.setStatus(description, true);
            if (this.pendingRowReveal?.tabId === tab.id) {
                this.pendingRowReveal = null;
            }
            if (wasDirty !== tab.panes.some(pane => pane.dirty)) {
                this.renderTabs();
            }
            this.renderActiveTab();
            this.updateToolbarState();

            if (options.flashSelection && tab.selection) {
                this.setTransientSelectionFlash(tab.id, paneIndex, tab.selection.startRow, tab.selection.endRow);
            }
        }

        copySelectionToNeighbor(direction) {
            const selection = this.getSelection();
            if (!selection) {
                return;
            }

            const targetPaneIndex = selection.paneIndex + direction;
            if (targetPaneIndex < 0 || targetPaneIndex >= selection.tab.panes.length) {
                return;
            }

            const lines = this.getTransferLinesFromPane(
                selection.tab,
                selection.paneIndex,
                targetPaneIndex,
                selection.startRow,
                selection.endRow
            );
            this.applyReplacement(
                selection.tab,
                targetPaneIndex,
                selection.startRow,
                selection.endRow,
                lines,
                'Copied selection from ' + selection.tab.panes[selection.paneIndex].label + ' to ' + selection.tab.panes[targetPaneIndex].label + '.'
            );
        }

        copyNeighborIntoSelection(direction) {
            const selection = this.getSelection();
            if (!selection) {
                return;
            }

            const sourcePaneIndex = selection.paneIndex + direction;
            if (sourcePaneIndex < 0 || sourcePaneIndex >= selection.tab.panes.length) {
                return;
            }

            const lines = this.getTransferLinesFromPane(
                selection.tab,
                sourcePaneIndex,
                selection.paneIndex,
                selection.startRow,
                selection.endRow
            );
            this.applyReplacement(
                selection.tab,
                selection.paneIndex,
                selection.startRow,
                selection.endRow,
                lines,
                'Replaced the current selection in ' + selection.tab.panes[selection.paneIndex].label + ' with text from ' + selection.tab.panes[sourcePaneIndex].label + '.'
            );
        }

        deleteSelection() {
            const selection = this.getSelection();
            if (!selection) {
                return;
            }

            if (!this.canDeleteSelection()) {
                this.setStatus('Nothing to delete in the current selection.');
                return;
            }

            this.applyReplacement(
                selection.tab,
                selection.paneIndex,
                selection.startRow,
                selection.endRow,
                [],
                'Deleted the current selection from ' + selection.tab.panes[selection.paneIndex].label + '.',
                { flashSelection: true }
            );
        }

        mergeSelection(order) {
            const selection = this.getSelection();
            if (!selection) {
                return;
            }

            const leftPaneIndex = selection.paneIndex - 1;
            const rightPaneIndex = selection.paneIndex + 1;

            if (leftPaneIndex < 0 || rightPaneIndex >= selection.tab.panes.length) {
                return;
            }

            const leftLines = this.getTransferLinesFromPane(selection.tab, leftPaneIndex, selection.paneIndex, selection.startRow, selection.endRow);
            const rightLines = this.getTransferLinesFromPane(selection.tab, rightPaneIndex, selection.paneIndex, selection.startRow, selection.endRow);
            const mergedLines = order === 'left-right'
                ? leftLines.concat(rightLines)
                : rightLines.concat(leftLines);

            this.applyReplacement(
                selection.tab,
                selection.paneIndex,
                selection.startRow,
                selection.endRow,
                mergedLines,
                'Merged neighboring selections into ' + selection.tab.panes[selection.paneIndex].label + '.'
            );
        }

        navigateHunk(direction) {
            const tab = this.getActiveTab();
            if (!tab || !tab.hunks.length) {
                return;
            }

            const currentRow = tab.selection ? tab.selection.startRow : -1;
            let targetIndex = 0;

            if (direction > 0) {
                targetIndex = tab.hunks.findIndex(hunk => hunk.start > currentRow);
                if (targetIndex === -1) {
                    targetIndex = 0;
                }
            } else {
                targetIndex = -1;
                for (let index = tab.hunks.length - 1; index >= 0; index -= 1) {
                    if (tab.hunks[index].end < currentRow || currentRow === -1) {
                        targetIndex = index;
                        break;
                    }
                }

                if (targetIndex === -1) {
                    targetIndex = tab.hunks.length - 1;
                }
            }

            const hunk = tab.hunks[targetIndex];
            const paneIndex = clamp(tab.focusPaneIndex, 0, tab.panes.length - 1);
            tab.focusPaneIndex = paneIndex;
            this.setSelection(tab, paneIndex, hunk.start, hunk.end, hunk.start, hunk.end);
            this.refreshSelectionVisuals();
            this.scrollToRow(hunk.start, { behavior: 'auto', block: 'center' });
        }

        scrollToRow(rowIndex, options = {}) {
            if (!this.gridScroll) {
                return;
            }

            const behavior = options.behavior || 'auto';
            const block = options.block || 'center';
            const currentTop = this.gridScroll.scrollTop;
            const viewportHeight = this.gridScroll.clientHeight;
            const headerHeight = this.headersContainerEl?.offsetHeight || 0;
            const scrollbarHeight = this.scrollbarRowEl?.offsetHeight || 0;
            const rowsTopOffset = this.rowsHostEl?.offsetTop || 0;
            const rowHeight = this.virtualRowHeight;
            const rowTop = rowIndex * rowHeight;
            const rowBottom = rowTop + rowHeight;
            const visibleTop = Math.max(0, currentTop + headerHeight - rowsTopOffset);
            const visibleBottom = Math.max(
                visibleTop,
                currentTop + viewportHeight - scrollbarHeight - rowsTopOffset
            );
            const visibleRowsHeight = Math.max(rowHeight, visibleBottom - visibleTop);
            const renderedRowEl = this.rowElements[rowIndex];

            let nextTop = currentTop;

            if (block === 'nearest' && renderedRowEl?.isConnected) {
                const gridRect = this.gridScroll.getBoundingClientRect();
                const headerRect = this.headersContainerEl?.getBoundingClientRect();
                const scrollbarRect = this.scrollbarRowEl?.getBoundingClientRect();
                const rowRect = renderedRowEl.getBoundingClientRect();
                const visibleTopPx = headerRect
                    ? Math.max(gridRect.top, headerRect.bottom)
                    : gridRect.top;
                const visibleBottomPx = scrollbarRect
                    ? Math.min(gridRect.bottom, scrollbarRect.top)
                    : gridRect.bottom;

                if (rowRect.top < visibleTopPx) {
                    nextTop = currentTop - (visibleTopPx - rowRect.top);
                } else if (rowRect.bottom > visibleBottomPx) {
                    nextTop = currentTop + (rowRect.bottom - visibleBottomPx);
                } else {
                    return;
                }
            } else if (block === 'nearest') {
                if (rowTop < visibleTop) {
                    nextTop = rowTop - headerHeight + rowsTopOffset;
                } else if (rowBottom > visibleBottom) {
                    nextTop = rowBottom - viewportHeight + scrollbarHeight + rowsTopOffset;
                } else {
                    return;
                }
            } else {
                nextTop = rowTop - Math.max(0, (visibleRowsHeight - rowHeight) / 2) - headerHeight + rowsTopOffset;
            }

            const maxTop = Math.max(0, this.gridScroll.scrollHeight - viewportHeight);
            this.gridScroll.scrollTo({
                top: clamp(Math.round(nextTop), 0, maxTop),
                behavior
            });
        }

        clearPendingSelectionMove() {
            this.pendingSelectionMove = null;
            if (this.pendingSelectionMoveFrame) {
                cancelAnimationFrame(this.pendingSelectionMoveFrame);
                this.pendingSelectionMoveFrame = 0;
            }
        }

        flushPendingSelectionMove() {
            this.pendingSelectionMoveFrame = 0;

            if (!this.pendingSelectionMove) {
                return;
            }

            if (performance.now() - this.lastSelectionMoveAt < this.selectionRepeatIntervalMs) {
                this.pendingSelectionMoveFrame = requestAnimationFrame(() => this.flushPendingSelectionMove());
                return;
            }

            const pendingMove = this.pendingSelectionMove;
            this.pendingSelectionMove = null;
            this.moveSelectionRow(pendingMove.direction, pendingMove.extendSelection);
            this.lastSelectionMoveAt = performance.now();
        }

        queueSelectionMove(direction, extendSelection = false, isRepeat = false) {
            if (!isRepeat) {
                this.clearPendingSelectionMove();
                this.moveSelectionRow(direction, extendSelection);
                this.lastSelectionMoveAt = performance.now();
                return;
            }

            this.pendingSelectionMove = { direction, extendSelection };

            if (!this.pendingSelectionMoveFrame) {
                this.pendingSelectionMoveFrame = requestAnimationFrame(() => this.flushPendingSelectionMove());
            }
        }

        moveFocusPane(direction) {
            const tab = this.getActiveTab();
            if (!tab || tab.panes.length <= 1) {
                return false;
            }

            const nextPaneIndex = tab.focusPaneIndex + direction;
            if (nextPaneIndex < 0 || nextPaneIndex >= tab.panes.length) {
                return false;
            }

            tab.focusPaneIndex = nextPaneIndex;

            if (tab.selection) {
                tab.selection = {
                    ...tab.selection,
                    paneIndex: nextPaneIndex
                };
            }

            this.refreshSelectionVisuals();

            const activeHeader = this.bodyEl.querySelector('.difference-pane-header.is-active');
            activeHeader?.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'nearest'
            });

            return true;
        }

        switchTab(direction) {
            if (!this.tabs.length) {
                return;
            }

            const currentIndex = this.tabs.findIndex(tab => tab.id === this.activeTabId);
            if (currentIndex === -1) {
                this.activeTabId = this.tabs[0].id;
                this.persistTabs();
                this.render();
                return;
            }

            const nextIndex = (currentIndex + direction + this.tabs.length) % this.tabs.length;
            this.activeTabId = this.tabs[nextIndex].id;
            this.persistTabs();
            this.render();
        }

        moveSelectionRow(direction, extendSelection = false) {
            const tab = this.getActiveTab();
            if (!tab || !tab.rows.length) {
                return;
            }

            const paneIndex = clamp(tab.focusPaneIndex, 0, tab.panes.length - 1);
            let targetRow = 0;

            if (tab.selection && tab.selection.paneIndex === paneIndex) {
                if (extendSelection) {
                    const anchorRow = tab.selection.anchorRow ?? tab.selection.startRow;
                    const activeRow = tab.selection.activeRow ?? tab.selection.endRow;
                    targetRow = activeRow + direction;
                    targetRow = clamp(targetRow, 0, tab.rows.length - 1);
                    this.setSelection(tab, paneIndex, anchorRow, targetRow, anchorRow, targetRow);
                    this.refreshSelectionVisuals();
                    this.scrollToRow(targetRow, { behavior: 'auto', block: 'nearest' });
                    return;
                }

                targetRow = direction > 0
                    ? tab.selection.endRow + 1
                    : tab.selection.startRow - 1;
            } else {
                targetRow = direction > 0 ? 0 : tab.rows.length - 1;
            }

            targetRow = clamp(targetRow, 0, tab.rows.length - 1);
            this.setSelection(tab, paneIndex, targetRow, targetRow, targetRow, targetRow);
            this.refreshSelectionVisuals();
            this.scrollToRow(targetRow, { behavior: 'auto', block: 'nearest' });
        }

        handleKeyUp(event) {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                this.clearPendingSelectionMove();
            }
        }

        handleKeyDown(event) {
            if (!this.isOpen()) {
                return;
            }

            if (this.diskChangeNoticeOpen) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.hideDiskChangeNotice();
                }
                return;
            }

            if (this.inlineEditor) {
                return;
            }

            const activeTab = this.getActiveTab();
            const imageTab = this.isImageTab(activeTab);

            const primaryModifier = event.ctrlKey || event.metaKey;
            const undoShortcut = primaryModifier && !event.shiftKey && !event.altKey && this.eventMatchesShortcutKey(event, {
                keys: ['z'],
                codes: ['KeyZ'],
                keyCodes: [90]
            });
            const redoShortcut = primaryModifier && !event.altKey && (
                this.eventMatchesShortcutKey(event, {
                    keys: ['y'],
                    codes: ['KeyY'],
                    keyCodes: [89]
                }) ||
                (event.shiftKey && this.eventMatchesShortcutKey(event, {
                    keys: ['z'],
                    codes: ['KeyZ'],
                    keyCodes: [90]
                }))
            );
            const saveShortcut = primaryModifier && !event.shiftKey && !event.altKey && this.eventMatchesShortcutKey(event, {
                keys: ['s'],
                codes: ['KeyS'],
                keyCodes: [83]
            });

            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
                return;
            }

            if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                if (!imageTab && event.shiftKey && event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.queueSelectionMove(-1, true, event.repeat);
                    return;
                }

                if (!imageTab && event.shiftKey && event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.queueSelectionMove(1, true, event.repeat);
                    return;
                }

                if (event.shiftKey) {
                    return;
                }

                if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    if (!this.moveFocusPane(-1)) {
                        this.switchTab(-1);
                    }
                    return;
                }

                if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    if (!this.moveFocusPane(1)) {
                        this.switchTab(1);
                    }
                    return;
                }

                if (!imageTab && event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.queueSelectionMove(-1, false, event.repeat);
                    return;
                }

                if (!imageTab && event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.queueSelectionMove(1, false, event.repeat);
                    return;
                }

                if (!imageTab && event.key === 'Delete') {
                    event.preventDefault();
                    this.deleteSelection();
                    return;
                }
            }

            if (undoShortcut) {
                event.preventDefault();
                this.undoActiveTab();
                return;
            }

            if (redoShortcut) {
                event.preventDefault();
                this.redoActiveTab();
                return;
            }

            if (saveShortcut) {
                event.preventDefault();
                this.saveAllTabs().catch(err => this.setStatus('Save failed: ' + err.message));
                return;
            }

            if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowUp') {
                event.preventDefault();
                this.navigateHunk(-1);
                return;
            }

            if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowDown') {
                event.preventDefault();
                this.navigateHunk(1);
                return;
            }

            if (event.ctrlKey && event.shiftKey && event.key === 'ArrowLeft') {
                event.preventDefault();
                this.copySelectionToNeighbor(-1);
                return;
            }

            if (event.ctrlKey && event.shiftKey && event.key === 'ArrowRight') {
                event.preventDefault();
                this.copySelectionToNeighbor(1);
                return;
            }

            if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowRight') {
                event.preventDefault();
                this.copyNeighborIntoSelection(-1);
                return;
            }

            if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowLeft') {
                event.preventDefault();
                this.copyNeighborIntoSelection(1);
                return;
            }

            if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'm') {
                event.preventDefault();
                if (event.shiftKey) {
                    this.mergeSelection('right-left');
                } else {
                    this.mergeSelection('left-right');
                }
            }
        }
    }

    window.differenceViewer = new DifferenceViewer(window.api);
})();
