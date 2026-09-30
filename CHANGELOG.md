# Changelog

Version numbers match `version-name` in metadata.json and the `vN` git tags. Each release on GitHub has the installable zip attached. extensions.gnome.org numbers its uploads on its own, so its version numbers can differ from these.

## 2 (2026-09-30)

- Names stay with their workspaces. When GNOME removes an empty workspace, or you drop a window between two workspaces in the overview, the names now move along with the workspaces instead of staying at their old positions. A workspace removed while the screen is locked can still shift the names, because GNOME turns extensions off on the lock screen.
- The name shows in the middle of every monitor. Renaming happens on one of them only (the one you clicked, or the one with the pointer for Super+F2). The new `all-monitors` setting goes back to a single screen.
- The README explains how to update, and what to check when nothing shows up (thanks to Paschalis Panteleris).
- The tests now run with one monitor and with three, and open real windows to check that names survive GNOME removing a workspace.

## 1 (2026-09-25)

First release, for GNOME 50.

- The workspace name appears in large type in the middle of the screen when you switch workspaces, and on demand with Super+F2. It also shows over fullscreen windows.
- Click the name, or press Super+F2 again, to rename the workspace. Enter saves, Esc or a click elsewhere cancels. Names are stored in GNOME's own `workspace-names` setting.
- Settings for the shortcut, the font size and how long the name stays up.
