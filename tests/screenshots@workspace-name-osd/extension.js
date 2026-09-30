import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'workspace-name-osd@nkyriazis.github.com';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const say = m => console.log(`OSDSHOT ${m}`);

async function capture(path) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    say(`saved ${path}`);
}

export default class Shots extends Extension {
    enable() {
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._id = 0;
            this._run().catch(e => say(`ERROR ${e}\n${e.stack}`)).finally(() => say('DONE'));
            return GLib.SOURCE_REMOVE;
        });
    }
    disable() { if (this._id) GLib.source_remove(this._id); }

    async _run() {
        const multi = Main.layoutManager.monitors.length > 1;
        // One monitor makes the README shots; several make the PR evidence.
        const out = GLib.getenv('WSOSD_SHOTS') + (multi ? '/pr-evidence/all-monitors' : '');
        const ext = Main.extensionManager.lookup(UUID).stateObj;
        const wm = global.workspace_manager;

        // Keep it up long enough to capture.
        ext._settings.set_int('switch-hold-ms', 10000);
        ext._settings.set_int('demand-hold-ms', 10000);

        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(1500);
        await capture(`${out}/switch.png`);

        // With several monitors, rename on the second one, where the
        // pointer is, to show the other screens keep the name.
        if (multi) {
            const m = Main.layoutManager.monitors[1];
            const seat = Clutter.get_default_backend().get_default_seat();
            const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            ptr.notify_absolute_motion(GLib.get_monotonic_time(), m.x + m.width - 40, m.y + m.height - 40);
            await sleep(300);
        }

        ext._onShortcut();
        await sleep(300);
        ext._onShortcut();
        await sleep(800);
        await capture(`${out}/rename.png`);
        ext._cancel();
    }
}
