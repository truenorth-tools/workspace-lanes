// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-workspace colour coding. Each workspace gets a colour (GNOME's
// accent palette by default, or the user's own); from it we generate a
// stylesheet with a muted shade for windows, a saturated one for the
// focused window, and tints for sections, previews and switcher
// thumbnails. Generating CSS rather than setting inline styles keeps
// hover and pressed states working.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {COLOR_PARTS, DEFAULT_PALETTE, INTENSITY, prefersDark, workspaceColor} from './palette.js';

export function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h * 60, s, l];
}

// Red, green and blue (0 to 1) from hue/saturation/lightness
export function hslToRgb(h, s, l) {
    s = Math.clamp(s, 0, 1);
    l = Math.clamp(l, 0, 1);
    const k = n => (n + h / 30) % 12;
    const c = s * Math.min(l, 1 - l);
    const f = n => l - c * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)];
}

// CSS colour from hue/saturation/lightness, with optional alpha
function hsla(h, s, l, a = 1) {
    const [r, g, b] = hslToRgb(h, s, l).map(v => Math.round(v * 255));
    return `rgba(${r}, ${g}, ${b}, ${+Math.clamp(a, 0, 1).toFixed(3)})`;
}

// The solid colour hsla(h, s, l, a) looks like when drawn over @bg (0 to 1)
function hslOver(h, s, l, a, bg) {
    a = Math.clamp(a, 0, 1);
    const [r, g, b] = hslToRgb(h, s, l)
        .map(v => Math.round((v * a + bg * (1 - a)) * 255));
    return `rgb(${r}, ${g}, ${b})`;
}

// GNOME's named accent colours and their hues
const ACCENT_HUES = {
    blue: 213, teal: 190, green: 128, yellow: 41,
    orange: 23, red: 353, pink: 330, purple: 285,
};

// The GNOME accent closest to @hex: slate for greyish colours, else the
// nearest hue
function nearestAccent(hex) {
    const [h, s] = hexToHsl(hex);
    if (s < 0.2)
        return 'slate';

    let best = 'blue', bestDistance = Infinity;
    for (const [name, hue] of Object.entries(ACCENT_HUES)) {
        const d = Math.abs(h - hue);
        const distance = Math.min(d, 360 - d);
        if (distance < bestDistance) {
            best = name;
            bestDistance = distance;
        }
    }
    return best;
}

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'workspace-lanes']);
const SHEET_NAME = /^colors-\d+\.css$/;

// Delete stylesheets left behind by earlier sessions (signing out doesn't
// always give the extension a chance to tidy up)
function clearOldSheets() {
    const dir = Gio.File.new_for_path(CACHE_DIR);
    let children;
    try {
        children = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return; // no cache folder yet
    }

    for (let info; (info = children.next_file(null));) {
        const name = info.get_name();
        if (!SHEET_NAME.test(name))
            continue;
        try {
            dir.get_child(name).delete(null);
        } catch (e) {
            console.warn(`Workspace Lanes: couldn't remove ${name}: ${e.message}`);
        }
    }
    children.close(null);
}

// The stylesheet for workspace @index. @level gives each part's intensity
// factor (0 leaves that part uncoloured): taskbar, previews and top bar.
function sheetFor(index, hex, light, level) {
    const [h, s, l] = hexToHsl(hex);
    const vividS = s * 1.2 + 0.05;
    const vivid = (a, dl = 0) => hsla(h, vividS, l + dl, a);
    const muted = (a, dl = 0) => hsla(h, s * 0.7, l + dl, a);

    // how strongly things are tinted at "medium", tuned so labels stay
    // readable
    const base = light
        ? {section: 0.1, sectionActive: 0.2, button: 0.22, hover: 0.32, focused: 0.5, focusedHover: 0.6}
        : {section: 0.12, sectionActive: 0.22, button: 0.38, hover: 0.5, focused: 0.85, focusedHover: 0.95};
    const t = Object.fromEntries(Object.entries(base)
        .map(([k, v]) => [k, v * level.taskbar]));
    // thumbnail windows: an outline and a see-through fill, so windows
    // behind others still show; the highlighted one is filled in. The
    // intensity scales their saturation.
    const ps = s * level.preview;
    const pvivid = (a, dl = 0) => hsla(h, vividS * level.preview, l + dl, a);
    const thumb = light ? {
        bg: hsla(h, ps * 0.55, 0.84),
        fill: hsla(h, ps * 0.6, 0.95, 0.4), edge: hsla(h, ps * 0.6, 0.45, 0.8),
        active: hsla(h, ps * 0.9, 0.85, 0.6), activeEdge: hsla(h, ps * 1.1, 0.35),
        lit: hsla(h, ps * 1.1, 0.72), litEdge: hsla(h, ps * 1.1, 0.3),
        dim: hsla(h, ps * 0.6, 0.95, 0.15), dimEdge: hsla(h, ps * 0.6, 0.45, 0.35),
    } : {
        bg: hsla(h, ps * 0.55, 0.24),
        fill: hsla(h, ps * 0.6, 0.68, 0.25), edge: hsla(h, ps * 0.6, 0.78, 0.75),
        active: hsla(h, ps * 0.9, 0.62, 0.4), activeEdge: pvivid(1, 0.75 - l),
        lit: pvivid(1, 0.62 - l), litEdge: pvivid(1, 0.85 - l),
        dim: hsla(h, ps * 0.6, 0.68, 0.1), dimEdge: hsla(h, ps * 0.6, 0.78, 0.35),
    };
    // the top bar: the colour the focused window's button shows at
    // "medium" (its tint over the active section's, over the bar), made
    // solid. The bottom bar is black in dark mode, near-white in light.
    const shown = 1 - (1 - base.focused) * (1 - base.sectionActive);
    const topBar = hslOver(h, vividS, l, shown * level.topBar, light ? 0.98 : 0);

    const ws = `.lanes-colors .lanes-ws-${index}`;
    let css = '';
    if (level.taskbar) {
        css += `
${ws}.lanes-section { background-color: ${muted(t.section)}; }
${ws}.lanes-section:hover { background-color: ${muted(t.section + 0.05)}; }
${ws}.lanes-section.active { background-color: ${vivid(t.sectionActive)}; box-shadow: inset 0 2px 0 0 ${vivid(level.taskbar)}; }
${ws} .lanes-section-label { background-color: ${muted(t.button)}; }
${ws}.lanes-section.active .lanes-section-label,
${ws}.lanes-ws-group.active .lanes-section-label { background-color: ${vivid(t.focused)}; }
${ws}.lanes-ws-group { background-color: ${muted(t.section + 0.04)}; }
${ws} .window-button > StWidget { background-color: ${muted(t.button)}; }
${ws} .window-button:hover > StWidget { background-color: ${muted(t.hover)}; }
${ws} .window-button.focused > StWidget { background-color: ${vivid(t.focused)}; }
${ws} .window-button.focused:hover > StWidget { background-color: ${vivid(t.focusedHover)}; }
${ws} .window-button.minimized > StWidget { background-color: ${muted(t.button * 0.5)}; }
`;
    }
    if (level.preview) {
        css += `
.lanes-colors.lanes-preview.lanes-ws-${index} { border-width: 2px; border-color: ${pvivid(0.9)}; }
${ws} .workspace { background-color: ${thumb.bg}; }
${ws} .workspace.active { border-color: ${pvivid(1, light ? -0.1 : 0.15)}; }
${ws} .window-list-workspace-indicator-window-preview { background-color: ${thumb.fill}; border-color: ${thumb.edge}; }
${ws} .window-list-workspace-indicator-window-preview.active { background-color: ${thumb.active}; border-color: ${thumb.activeEdge}; }
${ws} .window-list-workspace-indicator-window-preview.lanes-lit { background-color: ${thumb.lit}; border-color: ${thumb.litEdge}; }
${ws} .window-list-workspace-indicator-window-preview.lanes-dim { background-color: ${thumb.dim}; border-color: ${thumb.dimEdge}; }
`;
    }
    if (level.topBar) {
        css += `#panel.lanes-top-tint.lanes-ws-${index} { background-color: ${topBar}; transition-duration: 300ms; }
`;
        // in light style the top bar's text and icons are dark, as on
        // GNOME's own light top bar, except the red recording indicators
        if (light) {
            css += `#panel.lanes-top-tint.lanes-ws-${index} .panel-button { color: #222226; }
#panel.lanes-top-tint.lanes-ws-${index} .panel-button.screen-recording-indicator,
#panel.lanes-top-tint.lanes-ws-${index} .panel-button.screen-sharing-indicator { color: #fafafb; }
`;
        }
    }
    return css;
}

export class WorkspaceColors {
    constructor(settings, interfaceSettings) {
        this._settings = settings;
        this._interface = interfaceSettings;
        this._file = null;
        this._serial = 0;
        this._sheetCount = 0;
        this._topBarClass = null;
        this._accentWeSet = null;

        clearOldSheets();

        this._hasAccent = this._interface.settings_schema.has_key('accent-color');
        if (this._hasAccent) {
            this._interface.connectObject('changed::accent-color', () => {
                // changed by the user while we're in charge: that's now
                // the colour to give back
                const accent = this._interface.get_string('accent-color');
                if (this._accentWeSet && accent !== this._accentWeSet)
                    this._settings.set_string('saved-accent-color', accent);
            }, this);
        }
        this._settings.connectObject(
            'changed::color-workspaces', () => this._update(),
            'changed::workspace-colors', () => this._update(),
            ...Object.values(COLOR_PARTS).flatMap(key =>
                ['light', 'dark'].flatMap(style =>
                    [`changed::${key}-${style}`, () => this._update()])),
            'changed::match-accent-color', () => this._syncAccent(),
            this);
        global.workspace_manager.connectObject(
            'notify::n-workspaces', () => {
                // the stylesheet covers spare workspaces, so dynamic
                // workspaces coming and going rarely needs a new one
                if (global.workspace_manager.n_workspaces > this._sheetCount)
                    this._update();
            },
            'active-workspace-changed', () => {
                this._syncTopBar();
                this._syncAccent();
            },
            this);
        // the overview has its own see-through top bar
        Main.overview.connectObject(
            'showing', () => this._syncTopBar(),
            'hidden', () => this._syncTopBar(),
            this);
        // light or dark style: in GNOME Settings it picks the strengths,
        // in the shell the shades. Connected after the shell's own handler,
        // so after the shell reloads extension stylesheets ours is last.
        St.Settings.get().connectObject('notify::color-scheme',
            () => this._update(), this);

        this._update();
    }

    // The strength of @part (a key of COLOR_PARTS) for the style chosen in
    // GNOME Settings
    _intensity(part) {
        const style = prefersDark(this._interface) ? 'dark' : 'light';
        return INTENSITY[this._settings.get_string(`${COLOR_PARTS[part]}-${style}`)];
    }

    get enabled() {
        return this._settings.get_boolean('color-workspaces');
    }

    // Tint GNOME's top bar with the current workspace's colour
    _syncTopBar() {
        const panel = Main.panel;
        if (this._topBarClass)
            panel.remove_style_class_name(this._topBarClass);
        this._topBarClass = null;

        const show = this.enabled &&
            this._intensity('topBar') > 0 &&
            !Main.overview.visible;
        if (!show) {
            panel.remove_style_class_name('lanes-top-tint');
            return;
        }

        const index = global.workspace_manager.get_active_workspace_index();
        this._topBarClass = `lanes-ws-${index}`;
        panel.add_style_class_name('lanes-top-tint');
        panel.add_style_class_name(this._topBarClass);
    }

    // Set GNOME's accent colour to the current workspace's, saving the
    // user's own first and restoring it when this is off
    _syncAccent(forceOff = false) {
        if (!this._hasAccent)
            return;

        const saved = this._settings.get_string('saved-accent-color');
        const on = !forceOff && this.enabled &&
            this._settings.get_boolean('match-accent-color');

        if (!on) {
            this._accentWeSet = null;
            if (saved) {
                this._interface.set_string('accent-color', saved);
                this._settings.set_string('saved-accent-color', '');
            }
            return;
        }

        if (!saved) {
            this._settings.set_string('saved-accent-color',
                this._interface.get_string('accent-color'));
        }

        const custom = this._settings.get_strv('workspace-colors');
        const index = global.workspace_manager.get_active_workspace_index();
        const accent = nearestAccent(workspaceColor(custom, index));
        this._accentWeSet = accent;
        if (this._interface.get_string('accent-color') !== accent)
            this._interface.set_string('accent-color', accent);
    }

    _update() {
        this._unload();
        this._syncTopBar();
        this._syncAccent();
        if (!this.enabled)
            return;

        const light = Main.getStyleVariant() === 'light';
        const custom = this._settings.get_strv('workspace-colors');
        // whole palettes' worth, with at least one spare workspace
        const step = DEFAULT_PALETTE.length;
        const n = Math.ceil((global.workspace_manager.n_workspaces + 1) / step) * step;
        const level = Object.fromEntries(Object.keys(COLOR_PARTS)
            .map(part => [part, this._intensity(part)]));
        let css = '';
        for (let i = 0; i < n; i++)
            css += sheetFor(i, workspaceColor(custom, i), light, level);

        // a fresh file name each time, so St never serves a cached copy
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([CACHE_DIR, `colors-${++this._serial}.css`]));
        file.replace_contents(new TextEncoder().encode(css), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
        this._file = file;
        this._sheetCount = n;
    }

    _unload() {
        if (!this._file)
            return;

        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        try {
            this._file.delete(null);
        } catch {
        }
        this._file = null;
        this._sheetCount = 0;
    }

    destroy() {
        this._syncAccent(true);
        this._interface.disconnectObject(this);
        this._settings.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        this._unload();

        if (this._topBarClass)
            Main.panel.remove_style_class_name(this._topBarClass);
        Main.panel.remove_style_class_name('lanes-top-tint');
    }
}
