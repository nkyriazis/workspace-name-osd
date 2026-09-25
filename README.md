# Workspace Name OSD

A GNOME Shell extension that shows the name of the workspace in big letters in the middle of the screen every time you switch, so you always know where you landed. You can also bring the name up whenever you like, and rename the workspace right there.

![The workspace name shown after switching](docs/switch.png)

## Using it

Switch workspaces as usual (Ctrl+Alt+Left/Right, Super+Page Up/Down, or the overview) and the name appears for about a second. It also shows over fullscreen windows.

Press **Super+F2** to see the name of the current workspace without switching.

To rename, click the name while it is on screen, or press Super+F2 a second time. Type the new name and press Enter to keep it. Esc, or a click anywhere else, leaves the old name alone.

![Renaming a workspace](docs/rename.png)

The names are kept in GNOME's own `workspace-names` setting, so they survive reboots and show up in anything else that reads them. GNOME ties a name to a position (the second workspace from the left), not to the windows on it. With dynamic workspaces, removing an empty workspace moves the ones after it along, and they take the names of their new positions.

## Installing

GNOME 50 only for now (tested on Ubuntu 26.04).

```bash
git clone https://github.com/nkyriazis/workspace-name-osd.git
cd workspace-name-osd
make install
```

Log out and back in so GNOME Shell picks up the new extension (on Wayland there is no other way), then turn it on.

```bash
gnome-extensions enable workspace-name-osd@nkyriazis.github.com
```

### If nothing shows up

Check what GNOME thinks of the extension.

```bash
gnome-extensions info workspace-name-osd@nkyriazis.github.com
```

If it says `Enabled: Yes` but `State: INITIALIZED` rather than `ACTIVE`, all user-installed extensions are switched off. This is the "Extensions" toggle in the Extensions app, and Ubuntu sometimes sets it after an upgrade. Turn them back on (no logout needed) with

```bash
gsettings set org.gnome.shell disable-user-extensions false
```

If it is `ACTIVE` and still nothing appears, watch the log while switching workspaces.

```bash
journalctl --user -f -o cat | grep -iE "workspace-name|JS ERROR"
```

## Uninstalling

```bash
make uninstall
```

or, without the repo

```bash
gnome-extensions uninstall workspace-name-osd@nkyriazis.github.com
```

This turns the extension off and deletes it straight away, no logout needed. Its own settings (shortcut, size, timings) are left behind in dconf, and this clears them.

```bash
dconf reset -f /org/gnome/shell/extensions/workspace-name-osd/
```

Your workspace names belong to GNOME rather than to the extension, so uninstalling keeps them. To clear those as well

```bash
gsettings reset org.gnome.desktop.wm.preferences workspace-names
```

## Settings

There is no preferences window yet. All settings apply immediately, without logging out.

| Key | Default | What it does |
|---|---|---|
| `show-name` | `['<Super>F2']` | Shortcut to show the name, and to rename when pressed again |
| `font-size` | `96` | Size of the name in pixels |
| `switch-hold-ms` | `900` | How long the name stays up after a switch |
| `demand-hold-ms` | `2500` | How long it stays up after the shortcut |

For example, to make the name bigger

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/workspace-name-osd@nkyriazis.github.com/schemas \
  set org.gnome.shell.extensions.workspace-name-osd font-size 140
```

## Development

Changes to an extension normally take a logout to load, which makes testing slow. The scripts here start a separate GNOME Shell with no window (headless, with a virtual 1920×1080 monitor) and throwaway settings, load the extension from this folder, and drive it with simulated keyboard and mouse input. Your own desktop and workspace names are never touched.

```bash
make test     # run the checks
make shots    # regenerate the screenshots in docs/
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
