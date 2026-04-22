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
| Load Config | Loads a saved JSON config with folder paths, then starts a scan automatically. |
| Save Config | Saves the current folder paths as a JSON config. |
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
| Folder chevron | Expands or collapses one folder. |

### File Actions

Each file row can expose these actions in the right sticky action column.

| Action | What it does |
| --- | --- |
| Diffuse | Opens the selected existing files in the external Diffuse tool. Requires at least two existing files. |
| Difference | Opens the built-in Difference Viewer for that file across all configured targets. |
| Copy | Copies the selected source file into the checked target locations. |
| Delete | Deletes the checked existing files after confirmation. |

Use the radio button in a target column to choose the source file. Use checkboxes to choose target locations.

### Folder Actions

Folder rows support bulk actions.

| Action | What it does |
| --- | --- |
| Copy | Copies the selected source folder into the checked target folder locations. |
| Delete | Deletes the checked existing folders after confirmation. |

Use the radio button to choose the source folder. Use checkboxes to choose target folder locations.

### Scanning Behavior

The app watches the configured folders for changes. When files or folders change, it refreshes the comparison tree while preserving vertical and horizontal scroll position. Incremental updates are used where possible so small changes do not require a full rerender.

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
