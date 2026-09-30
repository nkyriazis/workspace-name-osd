import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const FADE_IN_MS = 120;
const FADE_OUT_MS = 350;
const EASE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

const State = {
    HIDDEN: 0,
    SHOWING: 1,
    EDITING: 2,
};

export default class WorkspaceOsdExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.preferences',
        });

        this._state = State.HIDDEN;
        this._index = 0;
        this._timeoutId = 0;
        this._unredirectDisabled = false;
        this._grab = null;
        this._overlays = [];
        this._editing = null;

        this._buildUi();

        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());

        this._switchId = global.workspace_manager.connect(
            'active-workspace-changed', () => this._onWorkspaceSwitched());

        this._trackWorkspaces();

        Main.wm.addKeybinding('show-name', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onShortcut());
    }

    disable() {
        Main.wm.removeKeybinding('show-name');

        if (this._switchId) {
            global.workspace_manager.disconnect(this._switchId);
            this._switchId = 0;
        }

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        this._untrackWorkspaces();

        this._clearTimeout();
        this._releaseModal();
        this._restoreUnredirect();

        this._destroyOverlays();
        this._entrySignalIds.forEach(id => this._entry.clutter_text.disconnect(id));
        this._entrySignalIds = null;
        this._entry.destroy();
        this._hint.destroy();
        this._entry = null;
        this._hint = null;

        this._settings = null;
        this._wmSettings = null;
    }

    _buildUi() {
        // One entry and hint, moved into whichever overlay is being edited,
        // so there is never more than one text box to type into.
        this._entry = new St.Entry({
            style_class: 'workspace-osd-entry',
            can_focus: true,
            visible: false,
        });

        this._hint = new St.Label({
            style_class: 'workspace-osd-hint',
            text: 'Enter to save, Esc to cancel',
            visible: false,
        });

        const text = this._entry.clutter_text;
        this._entrySignalIds = [
            text.connect('activate', () => this._commit()),
            text.connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this._cancel();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }),
        ];

        this._buildOverlays();
    }

    // One overlay per monitor, each centred on its own monitor.
    _buildOverlays() {
        this._overlays = Main.layoutManager.monitors.map(monitor => {
            const box = new St.BoxLayout({
                style_class: 'workspace-osd',
                orientation: Clutter.Orientation.VERTICAL,
                reactive: true,
                visible: false,
                opacity: 0,
            });

            const label = new St.Label({style_class: 'workspace-osd-text'});
            label.clutter_text.set_line_wrap(false);
            box.add_child(label);

            const overlay = {monitorIndex: monitor.index, box, label};

            // Same pattern as the shell's GrabHelper: while grabbed, clicks
            // anywhere on screen are routed through the grab actor.
            overlay.clickGesture = new Clutter.ClickGesture();
            overlay.clickId = overlay.clickGesture.connect('recognize',
                () => this._onClick(overlay));
            box.add_action(overlay.clickGesture);

            Main.layoutManager.addTopChrome(box);
            return overlay;
        });
    }

    _destroyOverlays() {
        // The entry and hint outlive the overlays; take them out first.
        for (const actor of [this._entry, this._hint])
            actor.get_parent()?.remove_child(actor);

        for (const {box, clickGesture, clickId} of this._overlays) {
            clickGesture.disconnect(clickId);
            Main.layoutManager.removeChrome(box);
            box.destroy();
        }
        this._overlays = [];
        this._editing = null;
    }

    // Hotplug or a resolution change. Start over with fresh overlays; an
    // edit in progress is dropped since its monitor may be gone.
    _onMonitorsChanged() {
        this._clearTimeout();
        this._releaseModal();
        this._destroyOverlays();
        this._buildOverlays();
        this._state = State.HIDDEN;
        this._restoreUnredirect();
    }

    // The overlays that take part in showing the name. With all-monitors
    // off only the monitor with the pointer shows it, as before.
    _activeOverlays() {
        if (this._settings.get_boolean('all-monitors'))
            return this._overlays;

        const monitor = Main.layoutManager.currentMonitor ??
            Main.layoutManager.primaryMonitor;
        const overlay = this._overlayFor(monitor);
        return overlay ? [overlay] : [];
    }

    _overlayFor(monitor) {
        return this._overlays.find(o => o.monitorIndex === monitor?.index) ??
            this._overlays[0] ?? null;
    }

    // --- triggers ---------------------------------------------------------

    _onWorkspaceSwitched() {
        if (this._state === State.EDITING)
            return;
        this._show(this._settings.get_int('switch-hold-ms'));
    }

    _onShortcut() {
        if (this._state === State.SHOWING)
            this._edit(this._shortcutOverlay());
        else if (this._state === State.HIDDEN)
            this._show(this._settings.get_int('demand-hold-ms'));
    }

    _onClick(overlay) {
        if (this._state === State.SHOWING) {
            this._edit(overlay);
            return;
        }

        // A click outside the panel cancels, like any other popup. The grab
        // sends clicks on any monitor to the overlay being edited.
        if (this._state === State.EDITING && overlay === this._editing) {
            const event = overlay.clickGesture.get_point_event(0);
            const target = global.stage.get_event_actor(event);
            if (!overlay.box.contains(target))
                this._cancel();
        }
    }

    // Super+F2 edits on the monitor with the pointer, if it shows the name.
    _shortcutOverlay() {
        const active = this._activeOverlays();
        const here = this._overlayFor(Main.layoutManager.currentMonitor);
        return active.includes(here) ? here : active[0];
    }

    // --- display ----------------------------------------------------------

    _show(holdMs) {
        this._index = global.workspace_manager.get_active_workspace_index();
        const name = Meta.prefs_get_workspace_name(this._index);
        this._editing = null;

        const active = this._activeOverlays();
        for (const overlay of this._overlays) {
            if (!active.includes(overlay))
                this._hideOverlay(overlay);
        }
        for (const {label} of active) {
            label.text = name;
            label.show();
        }
        this._entry.hide();
        this._hint.hide();
        this._applyFontSize();

        this._fadeIn(active);
        this._state = State.SHOWING;
        this._scheduleHide(holdMs);
    }

    // Only the overlay on one monitor turns into a text box. The others keep
    // showing the saved name until Enter, so no screen shows a name that is
    // not stored yet.
    _edit(overlay) {
        if (!overlay)
            return;
        this._clearTimeout();

        this._grab = Main.pushModal(overlay.box, {
            actionMode: Shell.ActionMode.POPUP,
        });
        this._state = State.EDITING;
        this._editing = overlay;

        overlay.label.hide();
        this._entry.text = overlay.label.text;
        for (const actor of [this._entry, this._hint]) {
            actor.get_parent()?.remove_child(actor);
            overlay.box.add_child(actor);
        }
        this._entry.show();
        this._hint.show();
        this._applyFontSize();
        this._fadeIn([overlay]);

        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, -1);
    }

    _commit() {
        const name = this._entry.text.trim();
        this._saveName(this._index, name);
        this._releaseModal();

        // Show the result briefly so the change is visible.
        this._show(this._settings.get_int('switch-hold-ms'));
    }

    _cancel() {
        this._releaseModal();
        this._state = State.SHOWING;
        this._hide();
    }

    _fadeIn(overlays) {
        this._suppressUnredirect();
        for (const overlay of overlays) {
            const {box} = overlay;
            box.remove_all_transitions();
            box.show();
            this._position(overlay);
            box.ease({
                opacity: 255,
                duration: FADE_IN_MS,
                mode: EASE_MODE,
            });
        }
    }

    // Fades every overlay out. The state and the compositor flag change once,
    // when the last one has gone.
    _hide() {
        this._clearTimeout();
        const shown = this._overlays.filter(o => o.box.visible);
        let left = shown.length;
        const done = () => {
            this._state = State.HIDDEN;
            this._restoreUnredirect();
        };
        if (left === 0) {
            done();
            return;
        }
        for (const {box} of shown) {
            box.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: EASE_MODE,
                onComplete: () => {
                    box.hide();
                    if (--left === 0)
                        done();
                },
            });
        }
    }

    _hideOverlay({box}) {
        box.remove_all_transitions();
        box.opacity = 0;
        box.hide();
    }

    _scheduleHide(ms) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeoutId = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _applyFontSize() {
        const style = `font-size: ${this._settings.get_int('font-size')}px;`;
        for (const {label} of this._overlays)
            label.style = style;
        this._entry.style = style;
    }

    _position({box, monitorIndex}) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return;

        const [, width] = box.get_preferred_width(-1);
        const [, height] = box.get_preferred_height(width);
        box.set_position(
            monitor.x + Math.floor((monitor.width - width) / 2),
            monitor.y + Math.floor((monitor.height - height) / 2));
    }

    // --- persistence ------------------------------------------------------

    // Names live in GNOME's own setting so other tools see the same names.
    // An empty name falls back to GNOME's default "Workspace N".
    _saveName(index, name) {
        const names = this._wmSettings.get_strv('workspace-names');
        while (names.length <= index)
            names.push('');
        names[index] = name;
        while (names.length > 0 && names[names.length - 1] === '')
            names.pop();
        this._wmSettings.set_strv('workspace-names', names);
    }

    // --- keeping names with their workspaces --------------------------------
    //
    // GNOME stores names by position. When a workspace goes away or a new
    // one is put between others, the later workspaces change position, so we
    // move their names along with them. Names stored past the last
    // workspace wait for workspaces that do not exist yet and move the same
    // way.

    _trackWorkspaces() {
        const wsm = global.workspace_manager;
        this._workspaces = this._listWorkspaces();
        this._wsSignalIds = [
            wsm.connect('workspace-added', (_wsm, index) => this._onWorkspaceAdded(index)),
            wsm.connect('workspace-removed', (_wsm, index) => this._onWorkspaceRemoved(index)),
            wsm.connect('workspaces-reordered', () => this._onWorkspacesReordered()),
        ];

        // Inserting a workspace from the overview does not add one in the
        // middle. The shell appends one at the end and moves every window
        // from that position onwards to the next workspace, so the names
        // have to move up by one too.
        const ext = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(Object.getPrototypeOf(Main.wm), 'insertWorkspace',
            original => function (pos) {
                const shifts = Meta.prefs_get_dynamic_workspaces() &&
                    pos < global.workspace_manager.n_workspaces;
                original.call(this, pos);
                if (shifts)
                    ext._insertNameAt(pos);
            });
    }

    _untrackWorkspaces() {
        this._injections.clear();
        this._injections = null;
        this._wsSignalIds.forEach(id => global.workspace_manager.disconnect(id));
        this._wsSignalIds = null;
        this._workspaces = null;
    }

    _listWorkspaces() {
        const wsm = global.workspace_manager;
        const list = [];
        for (let i = 0; i < wsm.n_workspaces; i++)
            list.push(wsm.get_workspace_by_index(i));
        return list;
    }

    // Adding or removing the last workspace moves nothing, so the names stay
    // where they are. A workspace appended later takes the name stored for
    // its position, as before, which is how names come back after a restart.
    // Mutter only ever appends, but a workspace added anywhere else would
    // push the later names up.
    _onWorkspaceAdded(index) {
        const last = index === this._workspaces.length;
        this._workspaces = this._listWorkspaces();
        if (!last)
            this._insertNameAt(index);
    }

    _onWorkspaceRemoved(index) {
        const last = index === this._workspaces.length - 1;
        this._workspaces = this._listWorkspaces();
        if (last)
            return;
        // _index is the workspace the OSD was opened on, so keep it there.
        if (index < this._index)
            this._index--;
        this._writeNames(names => names.splice(index, 1));
    }

    _onWorkspacesReordered() {
        const before = this._workspaces;
        this._workspaces = this._listWorkspaces();
        const from = this._workspaces.map(ws => before.indexOf(ws));
        this._index = Math.max(0, from.indexOf(this._index));
        this._writeNames(names => {
            const moved = from.map(i => names[i] ?? '');
            names.splice(0, moved.length, ...moved);
        });
    }

    _insertNameAt(index) {
        if (index <= this._index)
            this._index++;
        this._writeNames(names => {
            if (index < names.length)
                names.splice(index, 0, '');
        });
    }

    _writeNames(change) {
        const old = this._wmSettings.get_strv('workspace-names');
        const names = [...old];
        change(names);
        while (names.length > 0 && names[names.length - 1] === '')
            names.pop();
        if (JSON.stringify(names) !== JSON.stringify(old))
            this._wmSettings.set_strv('workspace-names', names);
    }

    // --- modal and compositor state ----------------------------------------

    _releaseModal() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    // Fullscreen windows are unredirected (drawn bypassing the compositor),
    // which would hide anything the shell paints on top. GNOME's own OSDs
    // switch that off while they are showing; so do we.
    _suppressUnredirect() {
        if (!this._unredirectDisabled) {
            global.compositor.disable_unredirect();
            this._unredirectDisabled = true;
        }
    }

    _restoreUnredirect() {
        if (this._unredirectDisabled) {
            global.compositor.enable_unredirect();
            this._unredirectDisabled = false;
        }
    }
}
