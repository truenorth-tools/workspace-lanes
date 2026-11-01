// SPDX-License-Identifier: GPL-2.0-or-later
//
// Makes "open an extension's settings" work when a settings window is
// already open. GNOME's settings service shows one extension settings
// window at a time and ignores requests while one is open, so a gear or
// Settings button (ours, Extension List's, any other in the shell) did
// nothing. Now the request brings that extension's window forward, or
// closes another extension's window and opens the one asked for.
//
// GNOME's own Extensions app talks to the settings service directly, so
// it isn't covered.

import GLib from 'gi://GLib';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTINGS_SERVICE = 'org.gnome.Shell.Extensions';

// How long to wait for another extension's settings window to close
const CLOSE_TIMEOUT = 2000;

function settingsWindows() {
    return global.display.list_all_windows().filter(w =>
        w.get_wm_class() === SETTINGS_SERVICE ||
        w.get_gtk_application_id() === SETTINGS_SERVICE);
}

export class SettingsWindowFocus {
    constructor() {
        this._injections = new InjectionManager();
        this._pending = null;

        const self = this;
        this._injections.overrideMethod(Main.extensionManager, 'openExtensionPrefs',
            original => function (uuid, parentWindow, options) {
                const extension = this.lookup(uuid);
                const open = settingsWindows();
                if (!extension?.hasPrefs || open.length === 0)
                    return original.call(this, uuid, parentWindow, options);

                // the window is titled with the extension's name
                const own = open.find(w => w.get_title() === extension.metadata.name);
                if (own) {
                    Main.activateWindow(own);
                    return true;
                }

                self._replace(open, () => original.call(this, uuid, parentWindow, options));
                return true;
            });
    }

    // Close the other settings windows, then open the requested one
    _replace(windows, openNew) {
        this._cancelPending();

        const alive = new Set(windows);
        const signals = windows.map(w => [w, w.connect('unmanaged', () => {
            alive.delete(w);
            if (alive.size === 0) {
                this._cancelPending();
                openNew();
            }
        })]);
        // if a window won't close (say it asks first), show it instead
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_TIMEOUT, () => {
            this._pending.timeoutId = 0;
            this._cancelPending();
            const [stuck] = alive;
            if (stuck)
                Main.activateWindow(stuck);
            return GLib.SOURCE_REMOVE;
        });
        this._pending = {signals, timeoutId};

        windows.forEach(w => w.delete(global.get_current_time()));
    }

    _cancelPending() {
        if (!this._pending)
            return;
        const {signals, timeoutId} = this._pending;
        signals.forEach(([w, id]) => w.disconnect(id));
        if (timeoutId)
            GLib.source_remove(timeoutId);
        this._pending = null;
    }

    destroy() {
        this._cancelPending();
        this._injections.clear();
    }
}
