# N-Way Compare

N-Way Compare is a desktop tool for comparing the same project, or code folder across multiple target directories. It is designed for workflows where you need to inspect differences, copy files or folders between targets, delete stale items, and review file-level changes without losing context.

## Main Page

The main page is the workspace comparison view. It compares two or more root folders and renders a sticky comparison tree with per-target status and actions.

### Folder Setup

Use the folder inputs at the top of the app to define the roots that participate in the comparison.

| Control | What it does |
| --- | --- |
| Add Folder | Adds a new folder input and opens the folder picker. If the input already contains a path, the picker opens from that location when possible. |
| Folder picker icon | Opens the folder picker for that specific input. |
| Folder X button | Removes that folder input from the comparison. At least two folder inputs are kept available. |
| Exclude files and folders | Skips matching relative paths during scan and folder watching. Use one pattern per line, such as `node_modules`, `dist`, or `*.log`. |
| Load Config | Loads a saved JSON config with folder paths, then starts a scan automatically. |
| Save Config | Saves the current folder paths and exclusion patterns as a JSON config. |
| Scan | Scans all configured folders and refreshes the comparison tree. |
| Run CMD | Runs the command from the command input once in each configured root folder. |

### Comparison Tree

After a scan, the tree shows files and folders found across the configured roots.

| UI element | Meaning |
| --- | --- |
| Left sticky path column | Shows the file or folder name, icon, relative path, and diff status while you scroll horizontally. |
| Target columns | Show whether each file or folder exists in each configured root. |
| Right sticky actions column | Keeps actions visible while you scroll horizontally. |
| Checkmark badge | The item is synced in the path/title column. |
| X badge | The item differs in the path/title column. |
| SYNCED | The item is present and equivalent for that target. |
| DIFF | The item exists but differs from at least one other target. |
| MISSING | The item does not exist in that target. |

### Tree Controls

| Control | What it does |
| --- | --- |
| Show only different | Filters the tree to rows and folders that contain differences. |
| Expand All | Expands every folder in the tree. |
| Expand Diff | Expands only folders that contain differences. |
| Collapse All | Collapses the tree. |
| Undo | Reverts the most recent main-page copy or delete action. |
| Redo | Reapplies the most recently undone main-page action. |
| Copy | Runs one batch copy for all rows that have a selected source and one or more selected targets. |
| Delete | Runs one batch delete for all selected existing targets. |
| Folder chevron | Expands or collapses one folder. |

### File Actions

Each file row can expose these actions in the right sticky action column.

| Action | What it does |
| --- | --- |
| Diffuse | Opens the selected existing files in the external Diffuse tool. Requires at least two existing files. |
| Difference | Opens the built-in Difference Viewer for that file across all configured targets. |

Use the radio button in a target column to choose the source file. Use checkboxes to choose target locations, then use the global `Copy` or `Delete` buttons in the tree toolbar.

### Folder Actions

Folder rows participate in the same global batch actions.

| Action | What it does |
| --- | --- |
| Copy | Copies selected source folders into checked target folder locations. |
| Delete | Deletes checked existing folders after confirmation. |

Use the radio button to choose the source folder. Use checkboxes to choose target folder locations.

### Main Page Undo and Redo

Main-page `Copy` and `Delete` actions are stored in an in-memory action history. A batch copy or delete is stored as one undo step. Each action keeps temporary snapshots of the affected target paths, so `Undo` can restore deleted items or previous overwritten target content, and `Redo` can reapply the same result.

Use the toolbar buttons, `Ctrl+Z`, `Ctrl+Y`, or `Ctrl+Shift+Z` while focus is not inside an input field. History is kept for the current app session and is cleared when the app closes.

Before a global batch action runs, the app shows a confirmation popup with the planned file and folder operations. Nested selections are skipped when a selected parent folder already covers them.

### Scanning Behavior

The app watches the configured folders for changes. When files or folders change, it refreshes the comparison tree while preserving vertical and horizontal scroll position. Incremental updates are used where possible so small changes do not require a full rerender.

Exclusion patterns are applied before entries are added to the comparison map. A plain name such as `node_modules` matches any path segment with that name, `*.log` matches file or folder names by basename, and path-like patterns such as `src/generated` skip that relative subtree.

### Exclusion Patterns

Use the `Exclude files and folders` box to skip noisy or heavy paths. Put one pattern per line.

| Pattern type | Example | What it excludes |
| --- | --- | --- |
| Folder or file name | `node_modules` | Any path segment named `node_modules`, at any depth. |
| Folder or file name | `dist` | Any folder or file named `dist`, at any depth. |
| Basename glob | `*.log` | Any file or folder name ending in `.log`, such as `scan-trace.log`. |
| Relative subtree | `src/generated` | The `src/generated` subtree from every configured root. |
| Relative glob subtree | `dist/**` | The `dist` folder and everything under it from every configured root. |

Exclusions also apply to folder watching, so ignored paths do not trigger automatic rescans.

## Difference Viewer

The Difference Viewer is the built-in multi-pane file diff and merge tool. It opens from the `Difference` action on a file row.

### Layout

| Area | What it does |
| --- | --- |
| Header | Shows the active comparison title, path/status, and global actions. |
| Tabs | Each opened comparison is kept in its own tab. Switching tabs restores that tab's state. |
| Toolbar | Provides change navigation, transfer/merge actions, and pane width controls. |
| File panes | Show one file per target column with aligned rows and inline highlights. |
| Quick diff scroller | The right overview bar shows where differences are located and lets you jump through the file. |
| Status bar | Shows the current selection or operation status. |

### Basic Usage

Click a row to select it. Drag within a pane to select multiple rows. Shift-click extends the current selection inside the same pane.

Double-click a row to edit it inline. Press `Ctrl+Enter` to commit the edit, `Esc` to cancel it, or click away to commit. Pressing `Tab` inside the editor inserts four spaces.

Use `Save All` or `Ctrl+S` to write dirty files to disk. Individual panes also show a `Save` button when that file has unsaved changes.

### Difference Viewer Buttons

| Button | Shortcut | What it does |
| --- | --- | --- |
| Save All | `Ctrl+S` | Saves all modified files in all open tabs. |
| Reload | None | Reloads the active tab from disk. |
| Close | `Esc` | Closes the Difference Viewer popup. |
| Prev | `Alt+Up` | Jumps to the previous diff hunk. |
| Next | `Alt+Down` | Jumps to the next diff hunk. |
| Sel -> L | `Shift+Ctrl+Left` | Copies the current selection into the file on the left. |
| Sel -> R | `Shift+Ctrl+Right` | Copies the current selection into the file on the right. |
| L -> Sel | `Ctrl+Right` | Replaces the current selection with the aligned text from the left file. |
| R -> Sel | `Ctrl+Left` | Replaces the current selection with the aligned text from the right file. |
| L + R | `Ctrl+M` | Merges left selection, then right selection, into the active file. |
| R + L | `Shift+Ctrl+M` | Merges right selection, then left selection, into the active file. |

### Keyboard Shortcuts

| Shortcut | What it does |
| --- | --- |
| `Esc` | Closes the Difference Viewer. When editing inline, cancels the edit instead. |
| `Ctrl+S` | Saves all modified files in all open comparison tabs. |
| `Ctrl+Z` | Undo in the active comparison tab. |
| `Ctrl+Y` | Redo in the active comparison tab. |
| `Ctrl+Shift+Z` | Redo in the active comparison tab. |
| `Alt+Up` | Jump to the previous diff hunk. |
| `Alt+Down` | Jump to the next diff hunk. |
| `ArrowUp` | Move the active row selection up. |
| `ArrowDown` | Move the active row selection down. |
| `Shift+ArrowUp` | Extend the row selection upward. |
| `Shift+ArrowDown` | Extend the row selection downward. |
| `ArrowLeft` | Move focus to the pane on the left. If there is no pane on the left, switch to the previous tab. |
| `ArrowRight` | Move focus to the pane on the right. If there is no pane on the right, switch to the next tab. |
| `Shift+Ctrl+Left` | Copy the selected rows into the neighboring file on the left. |
| `Shift+Ctrl+Right` | Copy the selected rows into the neighboring file on the right. |
| `Ctrl+Right` | Replace the current selection with aligned text from the left file. |
| `Ctrl+Left` | Replace the current selection with aligned text from the right file. |
| `Ctrl+M` | Merge left then right into the active file. |
| `Shift+Ctrl+M` | Merge right then left into the active file. |
| `Ctrl+Enter` | Commit an inline edit. |
| `Tab` | Insert four spaces while editing inline. |

### Quick Diff Scroller

The overview bar on the right provides a compact map of the current file comparison.

| Marker | Meaning |
| --- | --- |
| Red marks | Changed rows. |
| Blue marks | Missing rows or content gaps. |
| Viewport rectangle | The part of the file currently visible in the main panes. |
| Selection marker | The currently selected row range. |

Click or drag inside the overview bar to jump through the file.

### Undo and Redo

Undo and redo history is scoped per comparison tab. Switching tabs keeps each tab's own history. Closing a comparison tab removes its history.

### Notes

The Difference Viewer is intended for aligned multi-file review and quick merge operations. For external review, the main page can also open files in Diffuse when the external `diffuse` command is available on the system path.
