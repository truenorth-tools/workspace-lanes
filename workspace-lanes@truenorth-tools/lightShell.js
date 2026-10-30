// SPDX-License-Identifier: GPL-2.0-or-later
//
// Optionally let the shell itself go light when GNOME Settings is set to
// Light. The shell normally prefers dark, so only "prefer-light" (which
// Settings doesn't offer) makes it light. Like GNOME's Light Style
// extension, this changes the session's preference rather than the
// user's colour scheme setting, so Dark still gives a dark shell and
// turning this off puts everything back.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class LightShell {
    constructor(settings) {
        this._settings = settings;
        this._saved = null;

        this._settings.connectObject('changed::light-shell',
            () => this._sync(), this);
        this._sync();
    }

    _setScheme(scheme) {
        Main.sessionMode.colorScheme = scheme;
        St.Settings.get().notify('color-scheme');
    }

    _sync() {
        const on = this._settings.get_boolean('light-shell');
        if (on && this._saved === null) {
            this._saved = Main.sessionMode.colorScheme;
            this._setScheme('prefer-light');
        } else if (!on && this._saved !== null) {
            this._setScheme(this._saved);
            this._saved = null;
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._saved !== null)
            this._setScheme(this._saved);
        this._saved = null;
    }
}
