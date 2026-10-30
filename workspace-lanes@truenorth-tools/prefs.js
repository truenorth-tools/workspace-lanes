// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COLOR_PARTS, DEFAULT_PALETTE, INTENSITY, workspaceColor} from './palette.js';
import {WorkspacesPage} from './workspacePrefs.js';

function addRadioRows(group, actionName, choices) {
    for (const {value, title, subtitle} of choices) {
        const check = new Gtk.CheckButton({
            action_name: actionName,
            action_target: new GLib.Variant('s', value),
        });
        const row = new Adw.ActionRow({
            activatable_widget: check,
            title,
            subtitle: subtitle ?? '',
        });
        row.add_prefix(check);
        group.add(row);
    }
}

// Grey out @row while colour coding is off
function followColorCoding(settings, row) {
    settings.bind('color-workspaces', row, 'sensitive', Gio.SettingsBindFlags.GET);
}

// A drop-down row for the enum setting @key: @choices maps each of its
// values to a label
function choiceRow(settings, key, choices, title, subtitle) {
    const values = Object.keys(choices);
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(Object.values(choices)),
    });
    const load = () => {
        row.selected = Math.max(values.indexOf(settings.get_string(key)), 0);
    };
    load();
    settings.connect(`changed::${key}`, load);
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}

// A drop-down row choosing Off, Subtle, Medium or Strong for @key
function strengthRow(settings, key, title, subtitle) {
    const labels = [_('Off'), _('Subtle'), _('Medium'), _('Strong')];
    const choices = Object.fromEntries(
        Object.keys(INTENSITY).map((value, i) => [value, labels[i]]));
    return choiceRow(settings, key, choices, title, subtitle);
}

function toHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

// A colour picker for each workspace
class WorkspaceColorsGroup extends Adw.PreferencesGroup {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('Workspace Colours'),
            description: _('Muted shades for windows, a stronger one for the focused window.'),
        });

        this._settings = settings;

        const reset = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset('workspace-colors'));
        this.set_header_suffix(reset);

        const sync = () => {
            reset.sensitive = settings.get_strv('workspace-colors').length > 0;
            this._load();
        };
        settings.connect('changed::workspace-colors', sync);

        // one row per workspace, or a full palette's worth when dynamic;
        // kept in step as the count changes on the Workspaces page
        this._rows = [];
        this._buttons = [];
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._mutter.connect('changed::dynamic-workspaces', () => this._syncRows());
        this._wm.connect('changed::num-workspaces', () => this._syncRows());
        this._syncRows();
        sync();
    }

    // Add or remove workspace rows to match the number of workspaces
    _syncRows() {
        const count = this._mutter.get_boolean('dynamic-workspaces')
            ? DEFAULT_PALETTE.length
            : this._wm.get_int('num-workspaces');

        while (this._rows.length > count) {
            this.remove(this._rows.pop());
            this._buttons.pop();
        }

        const added = this._rows.length < count;
        while (this._rows.length < count) {
            const i = this._rows.length;
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                valign: Gtk.Align.CENTER,
            });
            button.connect('notify::rgba', () => this._onPicked(i, button.rgba));

            const row = new Adw.ActionRow({
                title: _('Workspace %d').format(i + 1),
                activatable_widget: button,
            });
            row.add_suffix(button);
            followColorCoding(this._settings, row);
            this.add(row);
            this._rows.push(row);
            this._buttons.push(button);
        }

        if (added)
            this._load();
    }

    _load() {
        this._loading = true;
        const custom = this._settings.get_strv('workspace-colors');
        this._buttons.forEach((button, i) => {
            const rgba = new Gdk.RGBA();
            rgba.parse(workspaceColor(custom, i));
            button.rgba = rgba;
        });
        this._loading = false;
    }

    _onPicked(index, rgba) {
        if (this._loading)
            return;

        const custom = this._settings.get_strv('workspace-colors');
        const hex = toHex(rgba);
        if (workspaceColor(custom, index) === hex)
            return;

        while (custom.length <= index)
            custom.push('');
        custom[index] = hex;
        this._settings.set_strv('workspace-colors', custom);
    }
}

// How strongly each part is coloured in light or dark style (@style)
class StrengthGroup extends Adw.PreferencesGroup {
    static {
        GObject.registerClass(this);
    }

    constructor(settings, style) {
        super({
            title: style === 'light'
                ? _('Colour Strength in Light Style')
                : _('Colour Strength in Dark Style'),
        });

        const rows = {
            taskbar: [_('Taskbar'), _('Lanes, bands and window buttons')],
            preview: [_('Previews'), _('The hover preview and the switcher’s thumbnails')],
            topBar: [_('Top bar'), _('At Medium it matches the focused window’s button')],
            background: [_('Backgrounds'), _('How saturated the workspace backgrounds are, when they’re on')],
        };
        for (const [part, key] of Object.entries(COLOR_PARTS)) {
            const [title, subtitle] = rows[part];
            const row = strengthRow(settings, `${key}-${style}`, title, subtitle);
            followColorCoding(settings, row);
            this.add(row);
        }

        // say which of the two is in use now
        const styleManager = Adw.StyleManager.get_default();
        const sync = () => {
            const current = styleManager.dark === (style === 'dark');
            this.description = current ? _('In use now') : '';
        };
        styleManager.connect('notify::dark', sync);
        sync();
    }
}

class ColorsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('Colours'),
            icon_name: 'preferences-color-symbolic',
        });

        const actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('colors', actionGroup);
        for (const key of ['color-workspaces', 'match-accent-color', 'light-shell'])
            actionGroup.add_action(settings.create_action(key));

        const mainGroup = new Adw.PreferencesGroup();
        this.add(mainGroup);

        mainGroup.add(new Adw.SwitchRow({
            title: _('Colour-code workspaces'),
            subtitle: _('Each workspace gets its own colour on the taskbar, in previews and on the top bar'),
            action_name: 'colors.color-workspaces',
        }));

        const accentRow = new Adw.SwitchRow({
            title: _('Match GNOME’s accent colour'),
            subtitle: _('The system accent colour follows the current workspace, using the nearest of GNOME’s accent colours. Your own comes back when this is off.'),
            action_name: 'colors.match-accent-color',
        });
        followColorCoding(settings, accentRow);
        mainGroup.add(accentRow);

        const backgroundRow = choiceRow(settings, 'workspace-backgrounds', {
            off: _('Off'),
            recolor: _('Recoloured wallpaper'),
            gradient: _('Gradient'),
        },
        _('Workspace backgrounds'),
        _('Each workspace’s background in its colour, on the desktop, in the overview and while switching'));
        followColorCoding(settings, backgroundRow);
        mainGroup.add(backgroundRow);

        // not part of colour coding, so never greyed out
        mainGroup.add(new Adw.SwitchRow({
            title: _('Light top bar and menus in Light style'),
            subtitle: _('GNOME’s top bar, menus and overview normally stay dark when GNOME Settings is set to Light. With this on, they follow it.'),
            action_name: 'colors.light-shell',
        }));

        this.add(new WorkspaceColorsGroup(settings));
        for (const style of ['light', 'dark'])
            this.add(new StrengthGroup(settings, style));
    }
}

class TaskbarPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('Taskbar'),
            icon_name: 'focus-windows-symbolic',
        });

        this._actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('taskbar', this._actionGroup);

        this._settings = settings;
        for (const key of ['layout', 'grouping-mode', 'show-on-all-monitors',
            'display-all-workspaces', 'minimize-on-click',
            'show-workspace-numbers'])
            this._actionGroup.add_action(this._settings.create_action(key));

        const layoutGroup = new Adw.PreferencesGroup({
            title: _('Layout'),
            description: _('Windows are always ordered by workspace, then left to right on screen.'),
        });
        this.add(layoutGroup);

        addRadioRows(layoutGroup, 'taskbar.layout', [{
            value: 'sections',
            title: _('Workspace lanes'),
            subtitle: _('One even-width lane per workspace. Hover a lane to preview it.'),
        }, {
            value: 'list',
            title: _('Window list'),
            subtitle: _('A single list with the workspace switcher on the right.'),
        }]);

        const delayRow = new Adw.SpinRow({
            title: _('Preview delay'),
            subtitle: _('Milliseconds to hover a lane before its preview opens'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 50,
                page_increment: 250,
            }),
        });
        settings.bind('preview-delay', delayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(delayRow);

        layoutGroup.add(new Adw.SwitchRow({
            title: _('Show workspace numbers'),
            subtitle: _('A number badge at the start of each lane'),
            action_name: 'taskbar.show-workspace-numbers',
        }));

        const groupingGroup = new Adw.PreferencesGroup({
            title: _('Window Grouping'),
        });
        this.add(groupingGroup);

        addRadioRows(groupingGroup, 'taskbar.grouping-mode', [
            {value: 'never', title: _('Never group windows')},
            {value: 'auto', title: _('Group windows when space is limited')},
            {value: 'always', title: _('Always group windows')},
        ]);

        const miscGroup = new Adw.PreferencesGroup();
        this.add(miscGroup);

        miscGroup.add(new Adw.SwitchRow({
            title: _('Click to minimize'),
            subtitle: _('Clicking the focused window’s button minimizes it'),
            action_name: 'taskbar.minimize-on-click',
        }));

        miscGroup.add(new Adw.SwitchRow({
            title: _('Show on all monitors'),
            action_name: 'taskbar.show-on-all-monitors',
        }));

        miscGroup.add(new Adw.SwitchRow({
            title: _('Show windows from all workspaces'),
            subtitle: _('Window list layout only'),
            action_name: 'taskbar.display-all-workspaces',
        }));
    }
}

export default class WorkspaceLanesPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new TaskbarPage(settings));
        window.add(new ColorsPage(settings));
        window.add(new WorkspacesPage(settings));
    }
}
