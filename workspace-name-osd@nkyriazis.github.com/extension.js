import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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

        this._buildUi();

        this._switchId = global.workspace_manager.connect(
            'active-workspace-changed', () => this._onWorkspaceSwitched());

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

        this._clearTimeout();
        this._releaseModal();
        this._restoreUnredirect();

        Main.layoutManager.removeChrome(this._box);
        this._box.destroy();
        this._box = null;
        this._label = null;
        this._entry = null;
        this._hint = null;

        this._settings = null;
        this._wmSettings = null;
    }

    _buildUi() {
        this._box = new St.BoxLayout({
            style_class: 'workspace-osd',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._label = new St.Label({style_class: 'workspace-osd-text'});
        this._label.clutter_text.set_line_wrap(false);

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

        this._box.add_child(this._label);
        this._box.add_child(this._entry);
        this._box.add_child(this._hint);

        // Same pattern as the shell's GrabHelper: while grabbed, clicks
        // anywhere on screen are routed through the grab actor.
        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this._onClick());
        this._box.add_action(this._clickGesture);

        this._entry.clutter_text.connect('activate', () => this._commit());
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._cancel();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addTopChrome(this._box);
    }

    // --- triggers ---------------------------------------------------------

    _onWorkspaceSwitched() {
        if (this._state === State.EDITING)
            return;
        this._show(this._settings.get_int('switch-hold-ms'));
    }

    _onShortcut() {
        if (this._state === State.SHOWING)
            this._edit();
        else if (this._state === State.HIDDEN)
            this._show(this._settings.get_int('demand-hold-ms'));
    }

    _onClick() {
        if (this._state === State.SHOWING) {
            this._edit();
            return;
        }

        // A click outside the panel cancels, like any other popup.
        if (this._state === State.EDITING) {
            const event = this._clickGesture.get_point_event(0);
            const target = global.stage.get_event_actor(event);
            if (!this._box.contains(target))
                this._cancel();
        }
    }

    // --- display ----------------------------------------------------------

    _show(holdMs) {
        this._index = global.workspace_manager.get_active_workspace_index();
        this._label.text = Meta.prefs_get_workspace_name(this._index);

        this._label.show();
        this._entry.hide();
        this._hint.hide();
        this._applyFontSize();

        this._fadeIn();
        this._state = State.SHOWING;
        this._scheduleHide(holdMs);
    }

    _edit() {
        this._clearTimeout();

        this._grab = Main.pushModal(this._box, {
            actionMode: Shell.ActionMode.POPUP,
        });
        this._state = State.EDITING;

        this._label.hide();
        this._entry.text = this._label.text;
        this._entry.show();
        this._hint.show();
        this._applyFontSize();
        this._fadeIn();

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

    _fadeIn() {
        this._suppressUnredirect();
        this._box.remove_all_transitions();
        this._box.show();
        this._position();
        this._box.ease({
            opacity: 255,
            duration: FADE_IN_MS,
            mode: EASE_MODE,
        });
    }

    _hide() {
        this._clearTimeout();
        this._box.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: EASE_MODE,
            onComplete: () => {
                this._box.hide();
                this._state = State.HIDDEN;
                this._restoreUnredirect();
            },
        });
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
        this._label.style = style;
        this._entry.style = style;
    }

    _position() {
        const monitor = Main.layoutManager.currentMonitor ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [, width] = this._box.get_preferred_width(-1);
        const [, height] = this._box.get_preferred_height(width);
        this._box.set_position(
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
