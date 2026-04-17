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
            this.gridScroll = null;
            this.dragSelection = null;
            this.lastStatus = 'Open a file from the Difference button to compare and merge changes.';

            this.build();
            document.addEventListener('keydown', this.handleKeyDown.bind(this));
            document.addEventListener('mousemove', this.handleGlobalMouseMove.bind(this));
            document.addEventListener('mouseup', this.handleGlobalMouseUp.bind(this));
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
            document.body.appendChild(this.modal);
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

                    cellEl.classList.toggle('is-selected', isSelected);
                    cellEl.classList.toggle('is-active-pane', paneIndex === tab.focusPaneIndex);
                });
            });

            if (tab) {
                this.updateStatusForTab(tab);
                this.updateToolbarState();
            }
        }

        getDifferenceRanges(sourceText, compareText) {
            if (typeof sourceText !== 'string' || typeof compareText !== 'string' || sourceText === compareText) {
                return [];
            }

            if (!sourceText.length) {
                return [];
            }

            let prefix = 0;
            const maxPrefix = Math.min(sourceText.length, compareText.length);
            while (prefix < maxPrefix && sourceText[prefix] === compareText[prefix]) {
                prefix += 1;
            }

            let suffix = 0;
            const maxSuffix = Math.min(sourceText.length - prefix, compareText.length - prefix);
            while (
                suffix < maxSuffix &&
                sourceText[sourceText.length - 1 - suffix] === compareText[compareText.length - 1 - suffix]
            ) {
                suffix += 1;
            }

            const start = prefix;
            const end = sourceText.length - suffix;
            if (end <= start) {
                return [{ start: 0, end: sourceText.length }];
            }

            return [{ start, end }];
        }

        getChangedRangesForCell(row, paneIndex) {
            const cell = row.cells[paneIndex];
            if (!cell || cell.missing || !cell.text) {
                return [];
            }

            const ranges = [];
            const leftCell = row.cells[paneIndex - 1];
            const rightCell = row.cells[paneIndex + 1];

            if (cell.changedLeft && leftCell && !leftCell.missing) {
                ranges.push(...this.getDifferenceRanges(cell.text, leftCell.text));
            }

            if (cell.changedRight && rightCell && !rightCell.missing) {
                ranges.push(...this.getDifferenceRanges(cell.text, rightCell.text));
            }

            if ((cell.changedLeft || cell.changedRight) && !ranges.length) {
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

        handleCellMouseDown(paneIndex, rowIndex, event) {
            if (event.button !== 0) {
                return;
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
            if (!this.dragSelection || !this.isOpen()) {
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
            const fileResults = await this.api.readFiles(descriptor.panes.map(pane => pane.path));
            const panes = descriptor.panes.map((pane, index) => {
                const result = fileResults[index] || {};
                return {
                    path: pane.path,
                    label: pane.label,
                    exists: Boolean(result.exists),
                    error: result.error || '',
                    content: result.content || '',
                    dirty: false
                };
            });

            const tab = {
                id: existingId || this.createTabId(),
                title: descriptor.title,
                relativePath: descriptor.relativePath,
                descriptor,
                panes,
                rows: [],
                hunks: [],
                dirty: false,
                focusPaneIndex: this.getDefaultFocusPaneIndex(panes),
                selection: null
            };

            return window.DifferenceEngine.rebuildTab(tab);
        }

        createTabId() {
            return 'difference-tab-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        }

        getDefaultFocusPaneIndex(panes) {
            const middle = Math.floor((panes.length - 1) / 2);
            if (panes[middle]?.exists) {
                return middle;
            }

            const existingIndex = panes.findIndex(pane => pane.exists);
            return existingIndex === -1 ? 0 : existingIndex;
        }

        async openComparison(descriptor) {
            await this.restoreSavedTabsOnce();

            const normalized = this.normalizeDescriptor(descriptor);
            const descriptorKey = this.getDescriptorKey(normalized);
            let tab = this.tabs.find(existing => this.getDescriptorKey(existing.descriptor) === descriptorKey);

            if (tab) {
                const refreshed = await this.loadTab(normalized, tab.id);
                Object.assign(tab, refreshed);
            } else {
                tab = await this.loadTab(normalized);
                this.tabs.push(tab);
            }

            this.activeTabId = tab.id;
            this.persistTabs();
            this.show();
            this.setStatus('Opened difference tab for ' + normalized.relativePath + '.', true);
            this.render();
        }

        show() {
            this.modal.classList.add('is-open');
            document.body.style.overflow = 'hidden';
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

            this.tabs = this.tabs.filter(item => item.id !== tabId);

            if (this.activeTabId === tabId) {
                this.activeTabId = this.tabs[0]?.id || null;
            }

            this.persistTabs();
            this.render();
        }

        async reloadActiveTab() {
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
            this.setStatus('Reloaded ' + tab.relativePath + ' from disk.');
            this.render();
        }

        async savePane(tab, paneIndex) {
            const pane = tab.panes[paneIndex];
            if (!pane || !pane.dirty) {
                return;
            }

            await this.api.writeFile({
                path: pane.path,
                content: pane.content
            });

            pane.dirty = false;
            pane.exists = true;
            window.DifferenceEngine.rebuildTab(tab);
            this.persistTabs();
            this.setStatus('Saved ' + pane.label + ' to ' + pane.path + '.');
        }

        async saveAllTabs() {
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

        renderActiveTab() {
            const tab = this.getActiveTab();
            const previousTop = this.gridScroll ? this.gridScroll.scrollTop : 0;
            const previousLeft = this.gridScroll ? this.gridScroll.scrollLeft : 0;

            this.bodyEl.innerHTML = '';
            this.gridScroll = null;
            this.rowElements = [];
            this.cellElements = [];
            this.headerElements = [];
            this.codeScrollerElements = [];
            this.codeContentElements = [];
            this.paneScrollbarElements = [];
            this.paneScrollbarSpacerElements = [];

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

            const compare = document.createElement('div');
            compare.className = 'difference-compare';

            const templateColumns = this.getPaneTemplateColumns(tab);

            const gridScroll = document.createElement('div');
            gridScroll.className = 'difference-grid-scroll';

            const grid = document.createElement('div');
            grid.className = 'difference-grid';

            const headers = document.createElement('div');
            headers.className = 'difference-pane-headers';
            headers.style.gridTemplateColumns = templateColumns;

            tab.panes.forEach((pane, paneIndex) => {
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
                saveBtn.type = 'button';
                saveBtn.className = 'difference-pane-btn' + (pane.dirty ? '' : ' is-disabled');
                saveBtn.textContent = pane.dirty ? 'Save' : 'Saved';
                saveBtn.title = 'Save this file';
                saveBtn.addEventListener('click', () => {
                    if (pane.dirty) {
                        this.savePane(tab, paneIndex)
                            .then(() => this.render())
                            .catch(err => this.setStatus('Save failed: ' + err.message));
                    }
                });

                labelRow.appendChild(label);
                labelRow.appendChild(saveBtn);

                const filePath = document.createElement('div');
                filePath.className = 'difference-pane-file';
                filePath.textContent = pane.path;
                filePath.title = pane.path;

                const state = document.createElement('div');
                state.className = 'difference-pane-state' + (pane.dirty ? ' is-dirty' : '');
                state.textContent = pane.dirty
                    ? 'Modified locally'
                    : pane.exists
                        ? 'On disk'
                        : 'Missing on disk';

                header.appendChild(labelRow);
                header.appendChild(filePath);
                header.appendChild(state);
                headers.appendChild(header);
                this.headerElements[paneIndex] = header;
            });

            grid.appendChild(headers);

            if (!tab.rows.length) {
                const empty = document.createElement('div');
                empty.className = 'difference-empty';
                empty.textContent = 'All compared files are empty.';
                grid.appendChild(empty);
            } else {
                const hunkStartSet = new Set(tab.hunks.map(hunk => hunk.start));

                tab.rows.forEach((row, rowIndex) => {
                    const rowEl = document.createElement('div');
                    const rowChanged = row.cells.some(cell => cell?.changedLeft || cell?.changedRight || cell?.missing);
                    rowEl.className = 'difference-row' +
                        (hunkStartSet.has(rowIndex) ? ' is-change-start' : '') +
                        (rowChanged ? ' is-changed' : '');
                    rowEl.style.gridTemplateColumns = templateColumns;
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
                        code.innerHTML = this.renderCodeMarkup(row, paneIndex);

                        cellEl.appendChild(gutter);
                        codeScroller.appendChild(code);
                        cellEl.appendChild(codeScroller);
                        cellEl.addEventListener('mousedown', (event) => this.handleCellMouseDown(paneIndex, rowIndex, event));
                        rowEl.appendChild(cellEl);
                        this.cellElements[rowIndex][paneIndex] = cellEl;
                        if (!this.codeScrollerElements[paneIndex]) {
                            this.codeScrollerElements[paneIndex] = [];
                        }
                        this.codeScrollerElements[paneIndex].push(codeScroller);
                        if (!this.codeContentElements[paneIndex]) {
                            this.codeContentElements[paneIndex] = [];
                        }
                        this.codeContentElements[paneIndex].push(code);
                    });

                    grid.appendChild(rowEl);
                    this.rowElements[rowIndex] = rowEl;
                });

                const filler = document.createElement('div');
                filler.className = 'difference-row-filler';
                filler.style.marginTop = '0';
                grid.appendChild(filler);

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
            }

            gridScroll.appendChild(grid);
            compare.appendChild(gridScroll);
            this.bodyEl.appendChild(compare);

            this.gridScroll = gridScroll;
            requestAnimationFrame(() => {
                if (this.gridScroll) {
                    this.gridScroll.scrollTop = previousTop;
                    this.gridScroll.scrollLeft = previousLeft;
                }
                this.refreshPaneScrollbarMetrics(tab);
                this.restorePaneScrollPositions(tab);
            });

            this.updateStatusForTab(tab);
            this.refreshSelectionVisuals();
        }

        refreshPaneScrollbarMetrics(tab) {
            this.ensurePaneScrollState(tab);
            const globalMaxScrollWidth = Math.max(
                0,
                ...this.codeContentElements.flatMap((codes) => (codes || []).map((code) => code.scrollWidth))
            );

            this.codeContentElements.forEach((codes) => {
                (codes || []).forEach((code) => {
                    code.style.width = globalMaxScrollWidth > 0 ? globalMaxScrollWidth + 'px' : '';
                });
            });

            this.paneScrollbarSpacerElements.forEach((spacer) => {
                if (spacer) {
                    spacer.style.width = (globalMaxScrollWidth + LINE_GUTTER_WIDTH) + 'px';
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

        syncPaneScroll(paneIndex, nextScrollLeft, sourceScroller = null) {
            const tab = this.getActiveTab();
            if (!tab) {
                return;
            }

            this.ensurePaneScrollState(tab);
            tab.paneScrollLefts = Array.from({ length: tab.panes.length }, () => nextScrollLeft);

            this.codeScrollerElements.forEach((scrollers) => {
                (scrollers || []).forEach((scroller) => {
                    if (scroller !== sourceScroller && scroller.scrollLeft !== nextScrollLeft) {
                        scroller.scrollLeft = nextScrollLeft;
                    }
                });
            });

            this.paneScrollbarElements.forEach((paneScrollbar) => {
                if (paneScrollbar && paneScrollbar !== sourceScroller && paneScrollbar.scrollLeft !== nextScrollLeft) {
                    paneScrollbar.scrollLeft = nextScrollLeft;
                }
            });
        }

        updateStatusForTab(tab) {
            const activePane = tab.panes[tab.focusPaneIndex];
            const selection = tab.selection
                ? 'Selection: rows ' + (tab.selection.startRow + 1) + '-' + (tab.selection.endRow + 1)
                : 'Selection: none';
            const hunks = tab.hunks.length + ' change hunk' + (tab.hunks.length === 1 ? '' : 's');
            const dirtyCount = tab.panes.filter(pane => pane.dirty).length;
            this.setStatus(
                'Active: ' + (activePane?.label || 'n/a') + ' | ' +
                selection + ' | ' +
                hunks + ' | ' +
                dirtyCount + ' dirty file' + (dirtyCount === 1 ? '' : 's')
            );
        }

        updateToolbarState() {
            const tab = this.getActiveTab();
            const hasSelection = Boolean(tab?.selection);
            const dirtyTabs = this.tabs.some(item => item.panes.some(pane => pane.dirty));

            this.toggleDisabled(this.saveAllBtn, !dirtyTabs);
            this.toggleDisabled(this.reloadBtn, !tab);
            this.toggleDisabled(this.prevHunkBtn, !tab || !tab.hunks.length);
            this.toggleDisabled(this.nextHunkBtn, !tab || !tab.hunks.length);
            this.toggleDisabled(this.copySelectionLeftBtn, !this.canCopySelectionToNeighbor(-1));
            this.toggleDisabled(this.copySelectionRightBtn, !this.canCopySelectionToNeighbor(1));
            this.toggleDisabled(this.copyLeftIntoSelectionBtn, !this.canCopyNeighborIntoSelection(-1));
            this.toggleDisabled(this.copyRightIntoSelectionBtn, !this.canCopyNeighborIntoSelection(1));
            this.toggleDisabled(this.mergeLeftRightBtn, !hasSelection || !tab || tab.focusPaneIndex <= 0 || tab.focusPaneIndex >= tab.panes.length - 1);
            this.toggleDisabled(this.mergeRightLeftBtn, !hasSelection || !tab || tab.focusPaneIndex <= 0 || tab.focusPaneIndex >= tab.panes.length - 1);
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

        canCopySelectionToNeighbor(direction) {
            const selection = this.getSelection();
            if (!selection) {
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

            const sourcePaneIndex = selection.paneIndex + direction;
            if (sourcePaneIndex < 0 || sourcePaneIndex >= selection.tab.panes.length) {
                return false;
            }

            return window.DifferenceEngine.selectionHasContent(selection.tab.rows, sourcePaneIndex, selection.startRow, selection.endRow);
        }

        applyReplacement(tab, paneIndex, startRow, endRow, replacementLines, description) {
            tab.panes[paneIndex] = window.DifferenceEngine.replacePaneSelection(tab, paneIndex, startRow, endRow, replacementLines);
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
            this.render();
            if (tab.selection) {
                this.scrollToRow(tab.selection.startRow);
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

            const lines = window.DifferenceEngine.getSelectedLines(selection.tab.rows, selection.paneIndex, selection.startRow, selection.endRow);
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

            const lines = window.DifferenceEngine.getSelectedLines(selection.tab.rows, sourcePaneIndex, selection.startRow, selection.endRow);
            this.applyReplacement(
                selection.tab,
                selection.paneIndex,
                selection.startRow,
                selection.endRow,
                lines,
                'Replaced the current selection in ' + selection.tab.panes[selection.paneIndex].label + ' with text from ' + selection.tab.panes[sourcePaneIndex].label + '.'
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

            const leftLines = window.DifferenceEngine.getSelectedLines(selection.tab.rows, leftPaneIndex, selection.startRow, selection.endRow);
            const rightLines = window.DifferenceEngine.getSelectedLines(selection.tab.rows, rightPaneIndex, selection.startRow, selection.endRow);
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
            tab.selection = {
                paneIndex,
                startRow: hunk.start,
                endRow: hunk.end,
                anchorRow: hunk.start,
                activeRow: hunk.end
            };

            this.render();
            this.scrollToRow(hunk.start);
        }

        scrollToRow(rowIndex) {
            const rowEl = this.rowElements[rowIndex];
            if (!rowEl) {
                return;
            }

            rowEl.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'nearest'
            });
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
                    this.scrollToRow(targetRow);
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
            this.scrollToRow(targetRow);
        }

        handleKeyDown(event) {
            if (!this.isOpen()) {
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
                return;
            }

            if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                if (event.shiftKey && event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.moveSelectionRow(-1, true);
                    return;
                }

                if (event.shiftKey && event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.moveSelectionRow(1, true);
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

                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.moveSelectionRow(-1);
                    return;
                }

                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.moveSelectionRow(1);
                    return;
                }
            }

            if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
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
