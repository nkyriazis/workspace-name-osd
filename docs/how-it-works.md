# How it works

All of the extension is in `extension.js`, about 500 lines. This page walks through it in the order things happen, then answers the questions a reviewer is likely to ask.

## Starting and stopping

GNOME calls `enable()` when the extension is turned on, at login and after every unlock, and `disable()` when it is turned off, including when the screen locks. Nothing happens before `enable()`.

`enable()` builds the on-screen parts, connects to three sources of events (monitors changing, the active workspace changing, workspaces being added, removed or reordered), wraps one shell function (see below), and registers the Super+F2 shortcut. `disable()` undoes each of these in turn. It removes the shortcut, disconnects every signal, removes the wrap, cancels the hide timer, releases the keyboard grab if a rename was in progress, and destroys every actor it created.

## What is on screen

Each monitor gets an overlay, a rounded box holding a label with the name, centred on that monitor (`_buildOverlays`). There is a single text box and a single "Enter to save, Esc to cancel" hint, shared by all monitors. They are moved into whichever overlay is being edited, so there can never be two text boxes to type into.

The overlays are added with `addTopChrome` so they sit above windows. When monitors are plugged in, removed or rearranged, all overlays are destroyed and rebuilt for the new layout (`_onMonitorsChanged`). A rename in progress is dropped at that point, since its monitor may no longer exist.

With the `all-monitors` setting off, only the overlay on the monitor with the pointer takes part, which was the behaviour before version 2.

## The three states

The extension is always in one of three states.

- **Hidden.** Nothing on screen.
- **Showing.** The name is up on every monitor and a timer will fade it out (`switch-hold-ms` after a switch, `demand-hold-ms` after Super+F2).
- **Editing.** One overlay shows the text box, the others keep showing the saved name, and the keyboard is grabbed.

Switching workspaces while hidden or showing shows the name (`_onWorkspaceSwitched`). Switching while editing is ignored. Super+F2 while hidden shows the name, and Super+F2 while showing starts a rename on the monitor with the pointer (`_onShortcut`). A click on a showing name starts a rename on that monitor (`_onClick`).

In the editing state `Main.pushModal` grabs keyboard and pointer, the same way the shell's own popups do. Enter saves and shows the new name briefly (`_commit`). Esc, or a click anywhere outside the box on any monitor, cancels (`_cancel`). Because of the grab, a click anywhere reaches the overlay being edited, and `_onClick` checks whether it landed inside the box.

## Fullscreen windows

GNOME draws a fullscreen window directly to the screen, bypassing the compositor, which would hide anything drawn on top. While the name is visible the extension calls `global.compositor.disable_unredirect()` and turns it back on when the last overlay has faded out, which is what GNOME's own on-screen displays do. A flag makes sure the two calls always stay paired, even when fades are interrupted.

## Where names live

Names are stored in GNOME's own setting, `workspace-names` in `org.gnome.desktop.wm.preferences`, a list indexed by position. The extension reads names through `Meta.prefs_get_workspace_name` and writes the list back when you rename (`_saveName`). An empty name removes the custom name, and GNOME shows its default "Workspace N".

Because the list is positional, a workspace disappearing would leave every later workspace with its neighbour's name. The last section of the file keeps names attached to their workspaces.

- When GNOME removes a workspace (`workspace-removed`), its entry is taken out of the list so the later names move down with their workspaces. Removing the last workspace changes nothing, which keeps names stored for workspaces that will come back, for example after a restart.
- When a window is dropped between two workspaces in the overview, GNOME does not insert a workspace in the middle. `Main.wm.insertWorkspace` appends one at the end and moves every window from that position on to the next workspace, and no signal reports this. The extension wraps that function with the shell's `InjectionManager` and inserts an empty name at the same position afterwards.
- `workspace-added` in the middle and `workspaces-reordered` are handled the same way. Nothing in GNOME 50 itself emits them in a way that moves workspaces, but another extension could.

Every write compares the new list with the old one and is skipped when nothing changed, and the extension never listens to changes of the setting itself, so it cannot end up rewriting its own writes.

While the extension is disabled, on the lock screen for instance, it cannot see workspaces change, so a workspace removed in that time still shifts the names.

## Testing

`make test` starts a separate GNOME Shell without a window (headless, with virtual monitors) and throwaway settings, loads the extension from the repo, and drives it with simulated keyboard and mouse input and real test windows. It runs once with one monitor and once with three. The same tests run on every pull request.

## Questions a reviewer may ask

**Why override `insertWorkspace`?** It is the only way to learn that a workspace was inserted from the overview. GNOME 50 appends the new workspace and moves windows, and emits nothing that says "inserted at position N". The override calls the original first, changes nothing about its behaviour, and only adjusts the stored names. It is removed in `disable()` with `InjectionManager.clear()`.

**Why `disable_unredirect()`?** Without it the name is invisible over fullscreen windows, which is where people most need to know which workspace they are on. It is paired with `enable_unredirect()` and never left on.

**Why `pushModal`?** Typing a new name needs the keyboard, and clicking elsewhere must cancel. This is the shell's standard mechanism for popups and is always released, on Enter, Esc, an outside click, a monitor change and in `disable()`.

**Why handle reordering if GNOME never reorders?** Names would silently land on the wrong workspaces if another extension reorders them, and handling it costs a few lines.

**Does it use the network, log anything, or spawn processes?** No. The test scripts in `tests/` are not part of the uploaded zip.
