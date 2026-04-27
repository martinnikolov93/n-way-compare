# N-Way Compare

N-Way Compare is a desktop app for comparing the same project across multiple folders at once.

It is built for workflows where you want to:
- compare several project variants side by side
- spot missing or different files quickly
- open a file diff across all targets
- copy files or folders from one target to others
- delete stale files or folders safely

## Main Page

The main page is where you choose folders, scan them, and work through the results.

### Typical Flow

1. Add the folders you want to compare.
2. Optionally add exclude patterns for paths you do not care about.
3. Click `Scan`.
4. Review the comparison tree.
5. Use `Difference` for file-level review, or use the global `Copy` and `Delete` actions for batch changes.

### Folder Setup

Use the folder inputs at the top of the app to define which roots should participate in the comparison.

| Control | What it does |
| --- | --- |
| Add Folder | Adds a new folder input and opens the folder picker. If the input already contains a path, the picker opens from that location when possible. |
| Folder picker icon | Opens the folder picker for that specific input. |
| Folder X button | Removes that folder input from the comparison. At least two folder inputs are kept available. |
| Exclude files and folders | Skips matching relative paths during scan and automatic refresh. Use one pattern per line, such as `node_modules`, `dist`, or `*.log`. |
| Load Config | Loads a saved JSON config with folder paths, then starts a scan automatically. |
| Save Config | Saves the current folder paths and exclusion patterns as a JSON config. |
| Scan | Scans all configured folders and refreshes the comparison tree. |
| Run CMD | Runs the command from the command input once in each configured root folder. |

### Comparison Tree

After a scan, the comparison tree shows the same relative file or folder across all selected targets, so you can quickly see what is present, missing, or different.

| UI element | Meaning |
| --- | --- |
| Name column | Shows the file or folder name, icon, relative path, and overall status. |
| Target columns | Show the state of that item in each selected folder. |
| Actions column | Keeps the row actions available while you move around the tree. |
| Checkmark badge | This item is in sync. |
| X badge | This item differs somewhere across the targets. |
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

Each file row can expose these actions in the actions column.

| Action | What it does |
| --- | --- |
| Diffuse | Opens the selected existing files in the external Diffuse tool. Requires at least two existing files. |
| Difference | Opens the built-in Difference Viewer for that file across all configured targets. |

To copy a file, choose one source with the radio button, check the targets you want to update, then use the global `Copy` button in the tree toolbar.

To delete, check the target locations you want to remove and use the global `Delete` button.

### Folder Actions

Folder rows work the same way as file rows.

| Action | What it does |
| --- | --- |
| Copy | Copies selected source folders into checked target folder locations. |
| Delete | Deletes checked existing folders after confirmation. |

If you select a parent folder, nested child selections under it are skipped automatically when the batch action runs.

### Undo and Redo

Main-page `Copy` and `Delete` actions can be undone and redone during the current app session.

Use the toolbar buttons, `Ctrl+Z`, `Ctrl+Y`, or `Ctrl+Shift+Z` while focus is not inside an input field.

Before a batch action runs, the app shows a confirmation popup so you can review what will happen.

### Automatic Refresh

After the first scan, the app keeps watching the selected folders. If something changes on disk, the comparison tree refreshes automatically and keeps your scroll position where possible.

### Exclusion Patterns

Use the `Exclude files and folders` box to skip paths you do not want to compare or watch. Put one pattern per line.

| Pattern type | Example | What it excludes |
| --- | --- | --- |
| Folder or file name | `node_modules` | Any path segment named `node_modules`, at any depth. |
| Folder or file name | `dist` | Any folder or file named `dist`, at any depth. |
| Basename glob | `*.log` | Any file or folder name ending in `.log`, such as `scan-trace.log`. |
| Relative subtree | `src/generated` | The `src/generated` subtree from every configured root. |
| Relative glob subtree | `dist/**` | The `dist` folder and everything under it from every configured root. |

These exclusions also apply to automatic refresh, so ignored paths do not trigger rescans.

## Difference Viewer

The Difference Viewer opens when you click `Difference` on a file row. It lets you compare the same file across all selected targets in one place.

### What You Can Do Here

| Area | What it does |
| --- | --- |
| Header | Shows the current file and the main actions for the viewer. |
| Tabs | Keep multiple open comparisons available at the same time. |
| Toolbar | Lets you jump between changes and move text between files. |
| File panes | Show one version of the file per target folder. |
| Quick diff scroller | Gives you a compact map of where the changes are. |
| Status bar | Shows selection and action feedback. |

### Basic Usage

Click a row to select it. Drag within a pane to select multiple rows. Shift-click extends the current selection inside the same pane.

Use the transfer and merge buttons to move selected text between neighboring panes.

Double-click a row to edit it inline. Press `Ctrl+Enter` to commit the edit, `Esc` to cancel it, or click away to commit. Press `Tab` inside the editor to insert four spaces.

Use `Save All` or `Ctrl+S` to write your changes to disk. Individual panes also show a `Save` button when that file has unsaved changes.

If the selected file is an image, the Difference Viewer switches into image preview mode automatically instead of text comparison. The current version supports side-by-side preview for `png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `svg`, `ico`, and `avif`.

If an opened file changes on disk while its tab is still open, the viewer pauses editing for that comparison and asks you to review the changed files. You can then choose `Reload from disk` or `Keep current version`.

### Difference Viewer Buttons

| Button | Shortcut | What it does |
| --- | --- | --- |
| Save All | `Ctrl+S` | Saves all modified files in all open tabs. |
| Reload | None | Reloads the active comparison from disk. |
| Close | `Esc` | Closes the Difference Viewer popup. |
| Prev | `Alt+Up` | Jumps to the previous change. |
| Next | `Alt+Down` | Jumps to the next change. |
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
| `Delete` | Deletes the selected row or row range from the active pane. |
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

The overview bar on the right gives you a small map of the current file comparison.

| Marker | Meaning |
| --- | --- |
| Red marks | Changed rows. |
| Blue marks | Missing rows or content gaps. |
| Viewport rectangle | The part of the file currently visible in the main panes. |
| Selection marker | The currently selected row range. |

Click or drag inside the overview bar to jump through the file.

### Undo and Redo

Undo and redo history is kept separately for each open comparison tab. If you switch tabs and come back, that tab keeps its own history. Closing a comparison tab clears its history.

## For Development

Run `npm test` to execute the diff regression suite.

The current test set focuses on the file-comparison logic that has been the most sensitive during development:

| Covered scenario | Why it matters |
| --- | --- |
| Multi-pane inserted block between blank rows | Protects the classic "extra lines in one target only" alignment case using synthetic prose. |
| First blank-line delete | Guards the selection and `Missing in this file` behavior after delete. |
| Repeated blank-line delete | Protects stability when deleting from the same blank block more than once. |
| Delete + move blank rows | Catches regressions where editing one block breaks an unrelated block above it. |
| Blank lines around changed text | Prevents simple line changes from turning into extra missing rows. |
| Numbered prose rows in two and four panes | Keeps `1:`, `2:` style text aligned by key as counts grow. |
| Copy into existing target rows | Verifies replacement stays one-to-one instead of creating extra gaps. |
| Copy blank runs into missing blocks | Protects blank-line transfers and merge actions. |
| Inline prose and numeric highlights | Verifies only the changed words or digits are highlighted, not surrounding punctuation. |
