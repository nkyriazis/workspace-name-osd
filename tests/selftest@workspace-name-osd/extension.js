import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
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
        await this._keepNames(ext, wm, wmPrefs, s, settle);
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

    // Phase 3: with dynamic workspaces, names follow their workspaces when
    // one is removed, inserted or reordered. Real windows from a small GTK
    // client make the shell remove an emptied workspace by itself.
    async _keepNames(ext, wm, wmPrefs, s, settle) {
        say('--- keep names phase');
        const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        const names = () => JSON.stringify(wmPrefs.get_strv('workspace-names'));
        const want = list => JSON.stringify(list);
        let writes = 0;
        const writesId = wmPrefs.connect('changed::workspace-names', () => writes++);

        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        launcher.unsetenv('DISPLAY');
        say(`client WAYLAND_DISPLAY=${GLib.getenv('WAYLAND_DISPLAY')}`);
        const procs = [];
        const open = async title => {
            const proc = launcher.spawnv([`${this.path}/client.py`, title]);
            procs.push(proc);
            for (let i = 0; i < 100; i++) {
                const win = global.get_window_actors().map(a => a.meta_window)
                    .find(w => w.get_title() === title);
                if (win)
                    return [proc, win];
                await sleep(100);
            }
            throw new Error(`window ${title} did not appear`);
        };
        const close = async proc => {
            proc.force_exit();
            await sleep(1500);
        };
        const go = async i => {
            wm.get_workspace_by_index(i).activate(global.get_current_time());
            await sleep(300);
        };
        const shown = async i => {
            await go(i);
            return ext()._label.text;
        };
        const at = win => win.get_workspace().index();

        await go(0);
        await settle();
        const stored = names();
        mutter.set_boolean('dynamic-workspaces', true);
        await sleep(1000);
        check('[keep] dynamic workspaces on', Meta.prefs_get_dynamic_workspaces() && wm.n_workspaces === 2, `n=${wm.n_workspaces}`);
        check('[keep] dropping empty workspaces at the end keeps their names', names() === stored, names());

        wmPrefs.set_strv('workspace-names', ['main', 'mail', 'code', 'music']);
        const [pA, wA] = await open('osd-A');
        const [pB, wB] = await open('osd-B');
        wB.change_workspace_by_index(1, false);
        await sleep(500);
        const [pC, wC] = await open('osd-C');
        wC.change_workspace_by_index(2, false);
        await sleep(1000);
        check('[keep] real windows on workspaces 1 to 3', wm.n_workspaces === 4 && at(wA) === 0 && at(wB) === 1 && at(wC) === 2,
            `n=${wm.n_workspaces} A=${at(wA)} B=${at(wB)} C=${at(wC)}`);
        check('[keep] appended workspaces leave names alone', names() === want(['main', 'mail', 'code', 'music']), names());

        // The shell removes workspace 2 by itself once its only window is gone.
        writes = 0;
        await close(pB);
        check('[keep] closing the last window removed the workspace', wm.n_workspaces === 3 && at(wC) === 1,
            `n=${wm.n_workspaces} C=${at(wC)}`);
        check('[keep] names moved down with their workspaces', names() === want(['main', 'code', 'music']), names());
        check('[keep] mutter reads the moved name', Meta.prefs_get_workspace_name(1) === 'code', Meta.prefs_get_workspace_name(1));
        check('[keep] switching to the old code workspace shows code', await shown(1) === 'code', ext()._label.text);
        check('[keep] trailing empty workspace keeps music', await shown(2) === 'music', ext()._label.text);
        await go(0);
        await settle();
        check('[keep] one write for the removal, no loop', writes === 1 && names() === want(['main', 'code', 'music']), `writes=${writes} ${names()}`);

        // Dropping a window between workspaces in the overview runs this.
        writes = 0;
        const [pD, wD] = await open('osd-D');
        Main.wm.insertWorkspace(1);
        Main.moveWindowToMonitorAndWorkspace(wD, wD.get_monitor(), 1, true);
        await sleep(1000);
        check('[keep] insert put a new workspace at 2', wm.n_workspaces === 4 && at(wA) === 0 && at(wD) === 1 && at(wC) === 2,
            `n=${wm.n_workspaces} A=${at(wA)} D=${at(wD)} C=${at(wC)}`);
        check('[keep] insert moved later names up', names() === want(['main', '', 'code', 'music']), names());
        const fresh = await shown(1);
        check('[keep] new workspace has the default name', !['main', 'code', 'music'].includes(fresh), fresh);
        check('[keep] code followed its workspace to 3', await shown(2) === 'code', ext()._label.text);
        await go(0);
        await settle();
        check('[keep] one write for the insert, no loop', writes === 1, `writes=${writes} ${names()}`);

        // No shell code reorders workspaces, but other extensions can.
        writes = 0;
        wm.reorder_workspace(wm.get_workspace_by_index(2), 0);
        await sleep(500);
        check('[keep] reorder moved the window', at(wC) === 0 && at(wA) === 1 && at(wD) === 2, `C=${at(wC)} A=${at(wA)} D=${at(wD)}`);
        check('[keep] reorder permuted names', names() === want(['code', 'main', '', 'music']), names());
        check('[keep] reordered workspace shows code', await shown(0) === 'code', ext()._label.text);
        await settle();
        check('[keep] one write for the reorder, no loop', writes === 1, `writes=${writes}`);

        // A workspace before the one being renamed goes away mid edit.
        await go(2);
        ext()._onShortcut();
        await sleep(100);
        ext()._onShortcut();
        await sleep(100);
        check('[keep] editing workspace 3', s() === 2 && ext()._index === 2, `state=${s()} index=${ext()._index}`);
        await close(pA);
        check('[keep] workspace removed while editing', wm.n_workspaces === 3 && at(wD) === 1, `n=${wm.n_workspaces} D=${at(wD)}`);
        check('[keep] edit follows its workspace', ext()._index === 1, `index=${ext()._index}`);
        ext()._entry.text = 'docs';
        ext()._commit();
        await sleep(200);
        check('[keep] commit lands on the edited workspace', names() === want(['code', 'docs', 'music']), names());
        await settle();

        // While disabled nothing is tracked (the lock screen case).
        const proto = Object.getPrototypeOf(Main.wm);
        const patched = proto.insertWorkspace;
        const obj = ext();
        obj.disable();
        check('[keep] disable restores insertWorkspace', proto.insertWorkspace !== patched && !Object.hasOwn(Main.wm, 'insertWorkspace'));
        writes = 0;
        await close(pC);
        check('[keep] removal while disabled is not tracked', wm.n_workspaces === 2 && writes === 0 && names() === want(['code', 'docs', 'music']),
            `n=${wm.n_workspaces} writes=${writes} ${names()}`);
        obj.enable();
        check('[keep] enable patches insertWorkspace again', proto.insertWorkspace !== patched && Object.hasOwn(proto, 'insertWorkspace'));
        await sleep(100);

        // Tracking works again after enable.
        const [pE, wE] = await open('osd-E');
        wE.change_workspace_by_index(1, false);
        await sleep(500);
        await go(1);
        await close(pD);
        check('[keep] removal after re-enable is tracked', wm.n_workspaces === 2 && at(wE) === 0 && names() === want(['docs', 'music']),
            `n=${wm.n_workspaces} E=${at(wE)} ${names()}`);
        ext()._onShortcut();
        await sleep(200);
        check('[keep] Super+F2 after re-enable shows docs', ext()._label.text === 'docs', ext()._label.text);
        await settle();

        procs.forEach(p => p.force_exit());
        await sleep(500);
        wmPrefs.disconnect(writesId);
        mutter.set_boolean('dynamic-workspaces', false);
    }
}
