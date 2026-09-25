import Gio from 'gi://Gio';
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
        const out = GLib.getenv('WSOSD_SHOTS');
        const ext = Main.extensionManager.lookup(UUID).stateObj;
        const wm = global.workspace_manager;

        // Keep it up long enough to capture.
        ext._settings.set_int('switch-hold-ms', 10000);
        ext._settings.set_int('demand-hold-ms', 10000);

        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(1500);
        await capture(`${out}/switch.png`);

        ext._onShortcut();
        await sleep(300);
        ext._onShortcut();
        await sleep(800);
        await capture(`${out}/rename.png`);
        ext._cancel();
    }
}
