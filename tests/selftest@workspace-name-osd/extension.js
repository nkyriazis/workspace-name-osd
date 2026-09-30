import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'workspace-name-osd@nkyriazis.github.com';
const HIDDEN = 0, SHOWING = 1, EDITING = 2;
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
// Polls instead of guessing a delay; CI renders in software and is slow.
const until = async (cond, ms = 3000) => {
    for (let t = 0; t < ms && !cond(); t += 50)
        await sleep(50);
    return cond();
};
const say = m => console.log(`OSDTEST ${m}`);

let failures = 0;
function check(name, cond, detail = '') {
    if (!cond) failures++;
    say(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

// Views over the per-monitor overlays of the running extension.
function helpers(ext) {
    const boxes = () => ext()._overlays.map(ov => ov.box);
    const walk = (actor, pred, out = []) => {
        if (pred(actor))
            out.push(actor);
        for (const c of actor.get_children())
            walk(c, pred, out);
        return out;
    };
    const classed = cls => a => a.has_style_class_name?.(cls);
    return {
        boxes,
        labels: () => ext()._overlays.map(ov => ov.label.text),
        allShown: () => boxes().every(b => b.visible && b.opacity > 0),
        allHidden: () => boxes().every(b => !b.visible),
        // Visible text entries anywhere in the shell's UI, not just ours.
        entries: () => walk(Main.layoutManager.uiGroup, classed('workspace-osd-entry')).filter(a => a.is_mapped()),
        stageBoxes: () => walk(Main.layoutManager.uiGroup, classed('workspace-osd')).length,
        others: () => ext()._overlays.filter(ov => ov !== ext()._editing),
        here: () => ext()._overlays.find(ov => ov.monitorIndex === Main.layoutManager.currentMonitor?.index) ?? ext()._overlays[0],
        checkCentred(tag) {
            for (const ov of ext()._overlays) {
                const m = Main.layoutManager.monitors[ov.monitorIndex];
                const [x, y] = ov.box.get_transformed_position();
                const [w, h] = ov.box.get_transformed_size();
                const dx = x + w / 2 - (m.x + m.width / 2), dy = y + h / 2 - (m.y + m.height / 2);
                check(`overlay centred on monitor ${ov.monitorIndex}${tag}`, Math.abs(dx) <= 2 && Math.abs(dy) <= 2,
                    `off by ${dx.toFixed(1)},${dy.toFixed(1)} box ${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}`);
            }
        },
    };
}

// Lay the monitors out again through org.gnome.Mutter.DisplayConfig, in
// reverse order from left to right, so every monitor but a middle one moves.
async function applyReversedMonitorConfig() {
    const call = (method, params) => new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, params, null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => { try { resolve(conn.call_finish(res)); } catch (e) { reject(e); } });
    });
    const [serial, monitors, logical] = (await call('GetCurrentState', null)).deep_unpack();
    const modeOf = connector => {
        const mon = monitors.find(([[c]]) => c === connector);
        const mode = mon[1].find(([, , , , , , props]) => props['is-current']?.deep_unpack());
        return mode[0];
    };
    const sorted = [...logical].sort((a, b) => a[0] - b[0]).reverse();
    let x = 0;
    const config = sorted.map(([oldX, , scale, transform, primary, mons]) => {
        const lx = x;
        x += Main.layoutManager.monitors.find(m => m.x === oldX).width;
        return [lx, 0, scale, transform, primary, mons.map(([connector]) => [connector, modeOf(connector), {}])];
    });
    await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, config, {}]));
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
        const o = helpers(ext);

        check('extension loaded', !!ext(), `state=${Main.extensionManager.lookup(UUID)?.state}`);
        say(`monitors ${JSON.stringify(Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height]))} primary=${Main.layoutManager.primaryIndex} onlyPrimary=${Meta.prefs_get_workspaces_only_on_primary()}`);
        check('4 workspaces', wm.n_workspaces >= 4, `n=${wm.n_workspaces}`);

        // 1. switch shows the name, then hides
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(200);
        check('switch -> SHOWING', s() === SHOWING, `state=${s()}`);
        check('label text is ws 2 name on every monitor', o.labels().every(t => t === 'two'), `texts=${o.labels()}`);
        check('box visible on every monitor', o.allShown(), `opacity=${o.boxes().map(b => b.opacity)}`);
        check('one overlay per monitor', ext()._overlays.length === Main.layoutManager.monitors.length, `overlays=${ext()._overlays.length}`);
        o.checkCentred('');
        check('unredirect suppressed while showing', ext()._unredirectDisabled === true);
        await settle();
        check('auto-hide -> HIDDEN', s() === HIDDEN, `state=${s()}`);
        check('box hidden on every monitor', o.allHidden());
        check('unredirect restored', ext()._unredirectDisabled === false);

        // 2. shortcut once shows, twice edits
        ext()._onShortcut();
        await sleep(200);
        check('shortcut -> SHOWING', s() === SHOWING, `state=${s()}`);
        ext()._onShortcut();
        await sleep(200);
        check('shortcut again -> EDITING', s() === EDITING, `state=${s()}`);
        check('entry visible, label hidden', ext()._entry.visible && !ext()._editing.label.visible);
        check('exactly one entry while editing', o.entries().length === 1, `entries=${o.entries().length}`);
        check('other monitors keep showing the name', o.others().every(ov => ov.box.visible && ov.label.visible && ov.label.text === 'two'));
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
        check('commit -> SHOWING new name everywhere', s() === SHOWING && o.labels().every(t => t === 'renamed'), `state=${s()} texts=${o.labels()}`);
        check('no entry after commit', o.entries().length === 0);
        await settle();
        check('after commit -> HIDDEN', s() === HIDDEN, `state=${s()}`);

        // 5. click on showing label edits; cancel restores nothing
        ext()._onShortcut();
        await sleep(200);
        ext()._onClick(ext()._overlays.at(-1));
        await sleep(200);
        check('click while SHOWING -> EDITING', s() === EDITING, `state=${s()}`);
        check('click edits on the clicked monitor', ext()._editing === ext()._overlays.at(-1));
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
        check('font size applied live', ext()._overlays.every(ov => ov.label.style.includes('150px')), `style=${ext()._overlays[0].label.style}`);
        o.checkCentred(' at 150px');
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
        check('disable removed overlays', obj._overlays.length === 0 && obj._entry === null);
        check('disable left no overlay actors', o.stageBoxes() === 0, `boxes=${o.stageBoxes()}`);
        check('disable balanced unredirect', obj._unredirectDisabled === false);
        obj.enable();
        await sleep(100);
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        await sleep(200);
        check('works after re-enable', s() === SHOWING, `state=${s()}`);
        await settle();
        check('hides after re-enable', s() === HIDDEN, `state=${s()}`);

        // 10. all-monitors off shows the name on one monitor only
        ext()._settings.set_boolean('all-monitors', false);
        ext()._onShortcut(); await sleep(200);
        const shown = ext()._overlays.filter(ov => ov.box.visible);
        check('all-monitors off -> one overlay', shown.length === 1, `shown=${shown.length}`);
        check('all-monitors off -> on current monitor',
            shown[0]?.monitorIndex === (Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor).index,
            `shown=${shown[0]?.monitorIndex}`);
        ext()._onShortcut(); await sleep(200);
        check('all-monitors off -> edits that overlay', ext()._editing === shown[0]);
        ext()._cancel();
        await settle();
        check('all-monitors off -> HIDDEN', s() === HIDDEN && o.allHidden(), `state=${s()}`);
        ext()._settings.set_boolean('all-monitors', true);

        // 11. monitors-changed rebuilds the overlays, even mid-edit
        ext()._onShortcut(); await sleep(100);
        ext()._onShortcut(); await sleep(100);
        const oldBoxes = o.boxes();
        await this._reconfigureMonitors();
        check('monitors-changed dropped the edit', s() === HIDDEN && ext()._grab === null, `state=${s()}`);
        check('monitors-changed rebuilt overlays', ext()._overlays.length === Main.layoutManager.monitors.length &&
            o.boxes().every(b => !oldBoxes.includes(b)), `overlays=${ext()._overlays.length} monitors=${Main.layoutManager.monitors.length}`);
        check('monitors-changed left no stale actors', o.stageBoxes() === ext()._overlays.length, `boxes=${o.stageBoxes()}`);
        check('monitors-changed balanced unredirect', ext()._unredirectDisabled === false);
        wm.get_workspace_by_index(2).activate(global.get_current_time());
        await sleep(200);
        check('shows after monitors-changed', s() === SHOWING && o.allShown(), `state=${s()}`);
        o.checkCentred(' after monitors-changed');
        await settle();

        await this._realInput(ext, wm, wmPrefs, s, settle, o);
        await this._keepNames(ext, wm, wmPrefs, s, settle);
    }

    // Phase 2: the same flows through synthetic keyboard and pointer events,
    // so the keybinding, the entry's key handling and the click gesture are
    // exercised the way a person would use them.
    // Ask mutter for a new monitor layout, which makes it emit
    // monitors-changed like a hotplug or a resolution change does. Falls back to emitting the
    // monitor manager signal if the D-Bus call is refused.
    // Phase 3: pointer and keyboard across monitors.
    async _multiMonitorInput({ext, wm, wmPrefs, s, settle, o, superF2, type, tap, clickAt, boxCentre, ptr, now}) {
        say('--- multi-monitor phase');
        const monitors = Main.layoutManager.monitors;
        const moveTo = async m => {
            ptr.notify_absolute_motion(now(), m.x + 50, m.y + 50);
            await sleep(120);
        };

        // Super+F2 twice edits on the monitor with the pointer, for each monitor
        for (const m of monitors) {
            await moveTo(m);
            await superF2();
            check(`[multi] Super+F2 on monitor ${m.index} -> SHOWING on all`, s() === SHOWING && o.allShown(), `state=${s()}`);
            await superF2();
            check(`[multi] Super+F2 again edits on monitor ${m.index}`, s() === EDITING && ext()._editing?.monitorIndex === m.index,
                `state=${s()} editing=${ext()._editing?.monitorIndex}`);
            check(`[multi] monitor ${m.index} one entry, inside its overlay`,
                o.entries().length === 1 && ext()._editing.box.contains(o.entries()[0]), `entries=${o.entries().length}`);
            check(`[multi] monitor ${m.index} others show the name`, o.others().every(ov => ov.box.visible && ov.label.visible));
            await tap(Clutter.KEY_Escape);
            await settle();
            check(`[multi] monitor ${m.index} Esc -> HIDDEN`, s() === HIDDEN && o.allHidden(), `state=${s()}`);
        }

        // Typing on a secondary monitor and Enter saves, shown everywhere
        const ws = wm.get_active_workspace_index();
        const last = monitors.at(-1);
        await moveTo(last);
        await superF2();
        await superF2();
        await type('side');
        await tap(Clutter.KEY_Return);
        check('[multi] Enter on secondary saves', wmPrefs.get_strv('workspace-names')[ws] === 'side',
            `names=${JSON.stringify(wmPrefs.get_strv('workspace-names'))}`);
        check('[multi] new name on every monitor', o.labels().every(t => t === 'side'), `texts=${o.labels()}`);
        await settle();

        // Click on the name on each monitor edits there
        for (const ov of ext()._overlays) {
            await superF2();
            const [cx, cy] = boxCentre(ov);
            await clickAt(cx, cy);
            check(`[multi] click on name on monitor ${ov.monitorIndex} edits there`,
                s() === EDITING && ext()._editing === ov, `state=${s()} editing=${ext()._editing?.monitorIndex}`);
            await tap(Clutter.KEY_Escape);
            await settle();
        }

        // Clicking another monitor's name while editing cancels, no second entry
        await superF2();
        const [ax, ay] = boxCentre(ext()._overlays[0]);
        await clickAt(ax, ay);
        check('[multi] editing on monitor 0', s() === EDITING && ext()._editing === ext()._overlays[0]);
        const [ox, oy] = boxCentre(ext()._overlays[1]);
        await clickAt(ox, oy);
        check('[multi] click on other monitor name cancels', s() !== EDITING && ext()._grab === null,
            `state=${s()} at ${Math.round(ox)},${Math.round(oy)}`);
        await settle();
        check('[multi] -> HIDDEN', s() === HIDDEN && o.allHidden(), `state=${s()}`);
        check('[multi] no entry on screen after cancel', o.entries().length === 0, `entries=${o.entries().length}`);

        // Clicking empty space on another monitor cancels
        await superF2();
        await superF2();
        const editIdx = ext()._editing.monitorIndex;
        const other = monitors.find(m => m.index !== editIdx);
        await clickAt(other.x + 30, other.y + other.height - 30);
        check('[multi] click on empty area of other monitor cancels', s() !== EDITING && ext()._grab === null, `state=${s()}`);
        check('[multi] cancel did not save', wmPrefs.get_strv('workspace-names')[ws] === 'side');
        await settle();
        check('[multi] unredirect balanced at the end', ext()._unredirectDisabled === false);
    }

    async _reconfigureMonitors() {
        const lm = Main.layoutManager;
        let fired = false;
        const id = lm.connect('monitors-changed', () => { fired = true; });
        try {
            await applyReversedMonitorConfig();
            for (let i = 0; i < 20 && !fired; i++)
                await sleep(100);
        } catch (e) {
            say(`note: ApplyMonitorsConfig failed (${e.message}), emitting instead`);
        }
        if (!fired) {
            say('note: no monitors-changed from mutter, emitting on the monitor manager');
            global.backend.get_monitor_manager().emit('monitors-changed');
        }
        lm.disconnect(id);
        await sleep(200);
        say(`monitors now ${JSON.stringify(lm.monitors.map(m => [m.x, m.y, m.width, m.height]))}`);
    }

    async _realInput(ext, wm, wmPrefs, s, settle, o) {
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
        // A person clicks on what they can see, so wait for fades to finish
        // before clicking and again before the caller checks the result.
        const settled = () => ext()._overlays.every(ov =>
            !ov.box.visible || (ov.box.opacity === 255 && !ov.box.get_transition('opacity')));
        const clickAt = async (x, y) => {
            await until(settled);
            ptr.notify_absolute_motion(now(), x, y);
            await sleep(80);
            ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(60);
            ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await sleep(250);
            await until(settled);
        };
        const boxCentre = (ov = ext()._editing ?? o.here()) => {
            const [x, y] = ov.box.get_transformed_position();
            const [w, h] = ov.box.get_transformed_size();
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
        const [bx, by] = ext()._editing.box.get_transformed_position();
        const [bw, bh] = ext()._editing.box.get_transformed_size();
        const mon = Main.layoutManager.monitors[ext()._editing.monitorIndex];
        const outX = bx + bw + 40 < mon.x + mon.width ? bx + bw + 40 : Math.max(mon.x, bx - 40);
        await clickAt(outX, by + bh / 2);
        check('[real] click outside cancels', s() !== EDITING && ext()._grab === null, `state=${s()} at ${Math.round(outX)}`);
        await settle();
        check('[real] after outside click -> HIDDEN', s() === HIDDEN, `state=${s()}`);

        // Keyboard shortcut for switching still shows the name
        await tap(Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_Right);
        await sleep(150);
        check('[real] Ctrl+Alt+Right -> SHOWING', s() === SHOWING, `state=${s()} ws=${wm.get_active_workspace_index()}`);
        await settle();

        if (Main.layoutManager.monitors.length > 1)
            await this._multiMonitorInput({ext, wm, wmPrefs, s, settle, o, superF2, type, tap, clickAt, boxCentre, ptr, now});

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
                if (win) {
                    // Only the primary monitor has workspaces by default
                    // (workspaces-only-on-primary); elsewhere a window is on
                    // all of them and never keeps a workspace alive. The
                    // shell places a new window when it first maps, which
                    // can undo an early move, so wait until it stays put.
                    const primary = Main.layoutManager.primaryIndex;
                    let stable = 0;
                    for (let j = 0; j < 60 && stable < 3; j++) {
                        if (win.get_monitor() !== primary)
                            win.move_to_monitor(primary);
                        stable = win.get_monitor() === primary && !win.is_on_all_workspaces()
                            ? stable + 1 : 0;
                        await sleep(100);
                    }
                    if (stable < 3)
                        say(`note ${title} monitor=${win.get_monitor()} primary=${primary} all=${win.is_on_all_workspaces()}`);
                    return [proc, win];
                }
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
            return ext()._overlays[0].label.text;
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
            `n=${wm.n_workspaces} A=${at(wA)} B=${at(wB)} C=${at(wC)} mon=${[wA, wB, wC].map(w => w.get_monitor())} all=${[wA, wB, wC].map(w => w.is_on_all_workspaces())} primary=${Main.layoutManager.primaryIndex}`);
        check('[keep] appended workspaces leave names alone', names() === want(['main', 'mail', 'code', 'music']), names());

        // The shell removes workspace 2 by itself once its only window is gone.
        writes = 0;
        await close(pB);
        check('[keep] closing the last window removed the workspace', wm.n_workspaces === 3 && at(wC) === 1,
            `n=${wm.n_workspaces} C=${at(wC)}`);
        check('[keep] names moved down with their workspaces', names() === want(['main', 'code', 'music']), names());
        check('[keep] mutter reads the moved name', Meta.prefs_get_workspace_name(1) === 'code', Meta.prefs_get_workspace_name(1));
        check('[keep] switching to the old code workspace shows code', await shown(1) === 'code', ext()._overlays[0].label.text);
        check('[keep] trailing empty workspace keeps music', await shown(2) === 'music', ext()._overlays[0].label.text);
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
        check('[keep] code followed its workspace to 3', await shown(2) === 'code', ext()._overlays[0].label.text);
        await go(0);
        await settle();
        check('[keep] one write for the insert, no loop', writes === 1, `writes=${writes} ${names()}`);

        // No shell code reorders workspaces, but other extensions can.
        writes = 0;
        wm.reorder_workspace(wm.get_workspace_by_index(2), 0);
        await sleep(500);
        check('[keep] reorder moved the window', at(wC) === 0 && at(wA) === 1 && at(wD) === 2, `C=${at(wC)} A=${at(wA)} D=${at(wD)}`);
        check('[keep] reorder permuted names', names() === want(['code', 'main', '', 'music']), names());
        check('[keep] reordered workspace shows code', await shown(0) === 'code', ext()._overlays[0].label.text);
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
        check('[keep] Super+F2 after re-enable shows docs', ext()._overlays[0].label.text === 'docs', ext()._overlays[0].label.text);
        await settle();

        procs.forEach(p => p.force_exit());
        await sleep(500);
        wmPrefs.disconnect(writesId);
        mutter.set_boolean('dynamic-workspaces', false);
    }
}
