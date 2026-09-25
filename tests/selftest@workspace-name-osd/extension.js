import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'workspace-name-osd@nkyriazis.github.com';
const HIDDEN = 0, SHOWING = 1, EDITING = 2;
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const say = m => console.log(`OSDTEST ${m}`);

let failures = 0;
function check(name, cond, detail = '') {
    if (!cond) failures++;
    say(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

export default class SelfTest extends Extension {
    enable() {
        // Let the session settle, then run once.
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            this._id = 0;
            this._run().catch(e => { failures++; say(`FAIL exception ${e}\n${e.stack}`); })
                .finally(() => { say(`DONE failures=${failures}`); });
            return GLib.SOURCE_REMOVE;
        });
    }
    disable() { if (this._id) GLib.source_remove(this._id); }

    async _run() {
        const ext = () => Main.extensionManager.lookup(UUID)?.stateObj;
        const wm = global.workspace_manager;
        const wmPrefs = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const s = () => ext()._state;
        const settle = () => sleep(900 + 350 + 400);

        check('extension loaded', !!ext(), `state=${Main.extensionManager.lookup(UUID)?.state}`);
        check('4 workspaces', wm.n_workspaces >= 4, `n=${wm.n_workspaces}`);

        // 1. switch shows the name, then hides
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(200);
        check('switch -> SHOWING', s() === SHOWING, `state=${s()}`);
        check('label text is ws 2 name', ext()._label.text === 'two', `text=${ext()._label.text}`);
        check('box visible', ext()._box.visible && ext()._box.opacity > 0, `opacity=${ext()._box.opacity}`);
        check('unredirect suppressed while showing', ext()._unredirectDisabled === true);
        await settle();
        check('auto-hide -> HIDDEN', s() === HIDDEN, `state=${s()}`);
        check('box hidden', !ext()._box.visible);
        check('unredirect restored', ext()._unredirectDisabled === false);

        // 2. shortcut once shows, twice edits
        ext()._onShortcut();
        await sleep(200);
        check('shortcut -> SHOWING', s() === SHOWING, `state=${s()}`);
        ext()._onShortcut();
        await sleep(200);
        check('shortcut again -> EDITING', s() === EDITING, `state=${s()}`);
        check('entry visible, label hidden', ext()._entry.visible && !ext()._label.visible);
        check('entry prefilled', ext()._entry.text === 'two', `text=${ext()._entry.text}`);
        check('modal grab held', ext()._grab !== null);

        // 3. edit mode does not time out, and ignores switches
        await settle();
        check('still EDITING after hold time', s() === EDITING, `state=${s()}`);
        wm.get_workspace_by_index(2).activate(global.get_current_time());
        await sleep(200);
        check('switch while editing keeps EDITING', s() === EDITING, `state=${s()}`);
        // modal blocks real switching, but API activation still switches; go back
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(200);

        // 4. commit persists the name
        ext()._entry.text = '  renamed  ';
        ext()._commit();
        await sleep(200);
        const names = wmPrefs.get_strv('workspace-names');
        check('commit saved trimmed name at index 1', names[1] === 'renamed', `names=${JSON.stringify(names)}`);
        check('other names untouched', names[0] === 'one' && names[2] === 'three' && names[3] === 'four', `names=${JSON.stringify(names)}`);
        check('grab released after commit', ext()._grab === null);
        check('commit -> SHOWING new name', s() === SHOWING && ext()._label.text === 'renamed', `state=${s()} text=${ext()._label.text}`);
        await settle();
        check('after commit -> HIDDEN', s() === HIDDEN, `state=${s()}`);

        // 5. click on showing label edits; cancel restores nothing
        ext()._onShortcut();
        await sleep(200);
        ext()._onClick();
        await sleep(200);
        check('click while SHOWING -> EDITING', s() === EDITING, `state=${s()}`);
        ext()._entry.text = 'should-not-save';
        ext()._cancel();
        await sleep(200);
        check('cancel released grab', ext()._grab === null);
        check('cancel did not save', wmPrefs.get_strv('workspace-names')[1] === 'renamed');
        await sleep(600);
        check('after cancel -> HIDDEN', s() === HIDDEN, `state=${s()}`);
        check('unredirect restored after cancel', ext()._unredirectDisabled === false);

        // 6. empty name clears back to default; beyond-list index pads
        wm.get_workspace_by_index(3).activate(global.get_current_time());
        await sleep(200);
        ext()._onShortcut(); await sleep(100);
        ext()._entry.text = '';
        ext()._commit();
        await sleep(200);
        const n2 = wmPrefs.get_strv('workspace-names');
        check('empty name trims trailing slot', n2.length === 3, `names=${JSON.stringify(n2)}`);
        await settle();

        // 7. live font size
        ext()._settings.set_int('font-size', 150);
        ext()._onShortcut(); await sleep(200);
        check('font size applied live', ext()._label.style.includes('150px'), `style=${ext()._label.style}`);
        await sleep(2500 + 350 + 400);

        // 8. rapid switching does not wedge the state
        for (let i = 0; i < 6; i++) {
            wm.get_workspace_by_index(i % 3).activate(global.get_current_time());
            await sleep(60);
        }
        await settle();
        check('rapid switching ends HIDDEN', s() === HIDDEN, `state=${s()}`);
        check('unredirect balanced after rapid switching', ext()._unredirectDisabled === false);

        // 9. disable while editing, then re-enable (lock/unlock path)
        ext()._onShortcut(); await sleep(100);
        ext()._onShortcut(); await sleep(100);
        check('editing before disable', s() === EDITING);
        const obj = ext();
        obj.disable();
        check('disable while editing cleared grab', obj._grab === null);
        check('disable nulled box', obj._box === null);
        obj.enable();
        await sleep(100);
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(200);
        check('works after re-enable', s() === SHOWING, `state=${s()}`);
        await settle();
        check('hides after re-enable', s() === HIDDEN, `state=${s()}`);

        await this._realInput(ext, wm, wmPrefs, s, settle);
    }

    // Phase 2: the same flows through synthetic keyboard and pointer events,
    // so the keybinding, the entry's key handling and the click gesture are
    // exercised the way a person would use them.
    async _realInput(ext, wm, wmPrefs, s, settle) {
        say('--- real input phase');
        const seat = Clutter.get_default_backend().get_default_seat();
        const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const now = () => GLib.get_monotonic_time();

        const key = async (keyval, state) => {
            kbd.notify_keyval(now(), keyval, state);
            await sleep(30);
        };
        const tap = async (...keyvals) => {
            for (const k of keyvals) await key(k, Clutter.KeyState.PRESSED);
            for (const k of [...keyvals].reverse()) await key(k, Clutter.KeyState.RELEASED);
            await sleep(150);
        };
        const type = async text => {
            for (const ch of text) await tap(Clutter.unicode_to_keysym(ch.codePointAt(0)));
        };
        const clickAt = async (x, y) => {
            ptr.notify_absolute_motion(now(), x, y);
            await sleep(80);
            ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(60);
            ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await sleep(250);
        };
        const boxCentre = () => {
            const [x, y] = ext()._box.get_transformed_position();
            const [w, h] = ext()._box.get_transformed_size();
            return [x + w / 2, y + h / 2];
        };
        const superF2 = () => tap(Clutter.KEY_Super_L, Clutter.KEY_F2);

        wm.get_workspace_by_index(0).activate(global.get_current_time());
        await settle();
        const before = wmPrefs.get_strv('workspace-names');

        // Keybinding: once shows, twice edits
        await superF2();
        check('[real] Super+F2 -> SHOWING', s() === SHOWING, `state=${s()}`);
        await superF2();
        check('[real] Super+F2 again -> EDITING', s() === EDITING, `state=${s()}`);

        // Typing replaces the preselected name; Enter saves
        await type('hello');
        check('[real] typing replaces selection', ext()._entry.text === 'hello', `text=${ext()._entry.text}`);
        await tap(Clutter.KEY_Return);
        const n1 = wmPrefs.get_strv('workspace-names');
        check('[real] Enter saves', n1[0] === 'hello', `names=${JSON.stringify(n1)}`);
        check('[real] Enter -> SHOWING', s() === SHOWING, `state=${s()}`);
        await settle();

        // Esc cancels
        await superF2();
        await superF2();
        await type('zzz');
        await tap(Clutter.KEY_Escape);
        check('[real] Esc does not save', wmPrefs.get_strv('workspace-names')[0] === 'hello');
        check('[real] Esc released grab', ext()._grab === null);
        await settle();
        check('[real] Esc -> HIDDEN', s() === HIDDEN, `state=${s()}`);

        // Click on the showing name edits
        await superF2();
        const [cx, cy] = boxCentre();
        await clickAt(cx, cy);
        check('[real] click on name -> EDITING', s() === EDITING, `state=${s()} at ${Math.round(cx)},${Math.round(cy)}`);

        // Click inside the entry keeps editing
        const [ex, ey] = boxCentre();
        await clickAt(ex, ey);
        check('[real] click inside panel keeps EDITING', s() === EDITING, `state=${s()}`);

        // Click outside cancels
        const [bx, by] = ext()._box.get_transformed_position();
        const [bw, bh] = ext()._box.get_transformed_size();
        const outX = bx + bw + 40 < global.stage.width ? bx + bw + 40 : Math.max(0, bx - 40);
        await clickAt(outX, by + bh / 2);
        check('[real] click outside cancels', s() !== EDITING && ext()._grab === null, `state=${s()} at ${Math.round(outX)}`);
        await settle();
        check('[real] after outside click -> HIDDEN', s() === HIDDEN, `state=${s()}`);

        // Keyboard shortcut for switching still shows the name
        await tap(Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_Right);
        await sleep(150);
        check('[real] Ctrl+Alt+Right -> SHOWING', s() === SHOWING, `state=${s()} ws=${wm.get_active_workspace_index()}`);
        await settle();

        wmPrefs.set_strv('workspace-names', before);
        kbd.run_dispose?.();
        ptr.run_dispose?.();
    }
}
