// SPDX-License-Identifier: GPL-2.0-or-later
//
// A background per workspace, in that workspace's colour: either the
// wallpaper recoloured (its light and dark parts mapped onto shades of the
// colour, so its shapes stay) or a gradient. Done with a shader on each
// background actor the shell draws for a workspace: the desktop's, the
// overview's workspace cards, the ones that slide past when switching
// and the hover preview's. Extensions that draw their own desktop
// backgrounds instead (PaperWM, which covers the desktop with one per
// workspace) get theirs recoloured too.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {hexToHsl, hslToRgb} from './colors.js';
import {COLOR_PARTS, INTENSITY, prefersDark, workspaceColor} from './palette.js';

const EFFECT_NAME = 'workspace-lanes-background';

const PAPERWM_UUID = 'paperwm@paperwm.github.com';

const DECLARATIONS = `
uniform float mode;
uniform vec3 shadow;
uniform vec3 mid;
uniform vec3 highlight;
float rand(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}
`;

// mode 0: map the wallpaper's brightness onto shadow → mid → highlight;
// mode 1: a top-to-bottom gradient from highlight to shadow, with a touch
// of noise so it doesn't band. Works on unpremultiplied colour so the
// overview's rounded corners stay intact.
const CODE = `
vec4 c = cogl_color_out;
if (c.a > 0.0) {
  vec3 rgb;
  if (mode < 0.5) {
    float y = dot(c.rgb / c.a, vec3(0.2126, 0.7152, 0.0722));
    rgb = y < 0.5
      ? mix(shadow, mid, y * 2.0)
      : mix(mid, highlight, y * 2.0 - 1.0);
  } else {
    vec2 st = cogl_tex_coord_in[0].st;
    rgb = mix(highlight, shadow, st.y);
    rgb += (rand(st) - 0.5) / 255.0;
  }
  cogl_color_out = vec4(rgb * c.a, c.a);
}
`;

// GNOME 51 replaced Shell.GLSLEffect with Clutter.ShaderEffect, which
// takes its snippet from a vfunc and sets uniforms by name
const TintEffect = Shell.GLSLEffect
    ? GObject.registerClass(
        class WorkspaceLanesTintEffect extends Shell.GLSLEffect {
            _init() {
                super._init();

                this._locations = {};
                for (const name of ['mode', 'shadow', 'mid', 'highlight'])
                    this._locations[name] = this.get_uniform_location(name);
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                    DECLARATIONS, CODE, false);
            }

            setColors({mode, shadow, mid, highlight}) {
                this.set_uniform_float(this._locations.mode, 1, [mode]);
                this.set_uniform_float(this._locations.shadow, 3, shadow);
                this.set_uniform_float(this._locations.mid, 3, mid);
                this.set_uniform_float(this._locations.highlight, 3, highlight);
                this.queue_repaint();
            }
        })
    : GObject.registerClass(
        class WorkspaceLanesTintEffect extends Clutter.ShaderEffect {
            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
                    DECLARATIONS, CODE);
            }

            setColors({mode, shadow, mid, highlight}) {
                this.set_uniform_float('mode', 1, [mode]);
                this.set_uniform_float('shadow', 3, shadow);
                this.set_uniform_float('mid', 3, mid);
                this.set_uniform_float('highlight', 3, highlight);
                this.queue_repaint();
            }
        });

// The shader's colours for a workspace colour @hex, in dark or light style,
// with saturation scaled by @strength (1 at "strong")
function shadesFor(hex, style, dark, strength) {
    const [h, s] = hexToHsl(hex);
    const c = (sat, light) => hslToRgb(h, Math.min(s * sat * strength, 1), light);
    if (style === 'gradient') {
        return dark
            ? {mode: 1, highlight: c(0.9, 0.3), mid: c(1, 0.2), shadow: c(1, 0.09)}
            : {mode: 1, highlight: c(0.8, 0.78), mid: c(0.9, 0.62), shadow: c(1, 0.45)};
    }
    return dark
        ? {mode: 0, shadow: c(1, 0.06), mid: c(1.05, 0.3), highlight: c(0.85, 0.68)}
        : {mode: 0, shadow: c(1, 0.2), mid: c(1, 0.5), highlight: c(0.7, 0.88)};
}

export class WorkspaceBackgrounds {
    constructor(settings, interfaceSettings) {
        this._settings = settings;
        this._interface = interfaceSettings;
        // background manager → the function giving its workspace's index
        this._tracked = new Map();
        // other extensions' background actors → their destroy handler id
        this._foreign = new Map();
        // containers under the desktop's background group being watched
        // for new background actors → their child-added and destroy ids
        this._watched = new Map();
        this._scanId = 0;
        // PaperWM's tiling module, to tell which workspace each of its
        // backgrounds belongs to
        this._paperwm = null;
        this._injections = new InjectionManager();

        this._interface.connectObject('changed::color-scheme',
            () => this._applyAll(), this);
        this._settings.connectObject(
            'changed::color-workspaces', () => this._applyAll(),
            'changed::workspace-backgrounds', () => this._applyAll(),
            'changed::workspace-colors', () => this._applyAll(),
            `changed::${COLOR_PARTS.background}-light`, () => this._applyAll(),
            `changed::${COLOR_PARTS.background}-dark`, () => this._applyAll(),
            this);
        // the desktop follows the active workspace; indices shift when
        // workspaces are added, removed or moved
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._applyAll(),
            'notify::n-workspaces', () => this._applyAll(),
            'workspaces-reordered', () => this._applyAll(),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueScan(), this);
        Main.extensionManager.connectObject('extension-state-changed',
            (_manager, extension) => {
                if (extension.uuid === PAPERWM_UUID)
                    this._loadPaperWM();
            }, this);

        this._inject();
        this._trackExisting();
        this._loadPaperWM();
        this._queueScan();
    }

    get _style() {
        if (!this._settings.get_boolean('color-workspaces'))
            return 'off';
        return this._settings.get_string('workspace-backgrounds');
    }

    // The saturation for the style chosen in GNOME Settings, relative to
    // "strong" (0 when off)
    _strength() {
        const style = prefersDark(this._interface) ? 'dark' : 'light';
        const level = this._settings.get_string(`${COLOR_PARTS.background}-${style}`);
        return INTENSITY[level] / INTENSITY.strong;
    }

    _activeIndex() {
        return global.workspace_manager.get_active_workspace_index();
    }

    _inject() {
        // eslint-disable-next-line consistent-this
        const self = this;

        // the overview's workspace cards (no workspace on monitors that
        // don't have workspaces of their own: those follow the active one)
        this._injections.overrideMethod(Workspace.Workspace.prototype, '_init',
            original => function (...args) {
                original.call(this, ...args);
                self._track(this._background?._bgManager,
                    () => this.metaWorkspace?.index() ?? self._activeIndex());
            });

        // the backgrounds that slide past while switching workspaces
        this._injections.overrideMethod(
            WorkspaceAnimation.WorkspaceBackground.prototype, '_createBackground',
            original => function (...args) {
                original.call(this, ...args);
                self._track(this._bgManager, () => this._workspace.index());
            });

        // the desktop's, recreated when monitors change
        this._injections.overrideMethod(Main.layoutManager, '_createBackgroundManager',
            original => function (...args) {
                const bgManager = original.call(this, ...args);
                self._track(bgManager, () => self._activeIndex());
                return bgManager;
            });

        this._injections.overrideMethod(Background.BackgroundManager.prototype, 'destroy',
            original => function (...args) {
                self._untrack(this);
                original.call(this, ...args);
            });
    }

    // Pick up the backgrounds that were made before we were enabled
    _trackExisting() {
        for (const bgManager of Main.layoutManager._bgManagers ?? [])
            this._track(bgManager, () => this._activeIndex());

        const visit = actor => {
            if (actor instanceof Workspace.Workspace) {
                this._track(actor._background?._bgManager,
                    () => actor.metaWorkspace?.index() ?? this._activeIndex());
                return;
            }
            for (const child of actor.get_children())
                visit(child);
        };
        visit(Main.layoutManager.overviewGroup);
    }

    // PaperWM keeps a Space per workspace, each with its own background
    // actor; its module is already loaded, so importing it gives the live
    // one rather than a copy
    async _loadPaperWM() {
        const extension = Main.extensionManager.lookup(PAPERWM_UUID);
        let paperwm = null;
        if (extension?.state === ExtensionState.ACTIVE) {
            try {
                paperwm = await import(extension.dir.get_child('tiling.js').get_uri());
            } catch (e) {
                console.debug(`Workspace Lanes: can't read PaperWM's workspaces: ${e}`);
            }
        }
        if (this._destroyed)
            return;
        this._paperwm = paperwm;
        this._queueScan();
    }

    // Other extensions' backgrounds get added at odd times (on enable, when
    // monitors or workspaces change, when the wallpaper changes), so look
    // for them once things settle
    _queueScan() {
        if (this._scanId)
            return;
        this._scanId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scanId = 0;
            this._scanForeign();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Track every background actor under the desktop's background group
    // that isn't one of the shell's own, and watch the containers on the
    // way for new ones
    _scanForeign() {
        const own = new Set();
        for (const bgManager of this._tracked.keys()) {
            own.add(bgManager.backgroundActor);
            own.add(bgManager._newBackgroundActor);
        }

        const visit = actor => {
            if (actor instanceof Meta.BackgroundActor) {
                if (!own.has(actor))
                    this._trackForeign(actor);
                return;
            }
            // window clones can't hold a desktop background
            if (actor instanceof Meta.WindowActor || actor instanceof Clutter.Clone)
                return;

            if (!this._watched.has(actor)) {
                this._watched.set(actor, [
                    actor.connect('child-added', () => this._queueScan()),
                    actor.connect('destroy', () => this._watched.delete(actor)),
                ]);
            }
            for (const child of actor.get_children())
                visit(child);
        };
        visit(Main.layoutManager._backgroundGroup);
    }

    _trackForeign(actor) {
        if (!this._foreign.has(actor)) {
            this._foreign.set(actor, actor.connect('destroy',
                () => this._foreign.delete(actor)));
        }
        this._applyForeign(actor);
    }

    // The workspace a background of another extension shows: PaperWM's
    // belong to the Space they sit in, anything else follows the active one
    _foreignIndex(actor) {
        const spaces = this._paperwm?.spaces;
        if (spaces) {
            try {
                for (const space of spaces.values()) {
                    if (space.actor?.contains(actor))
                        return space.workspace.index();
                }
            } catch (e) {
                console.debug(`Workspace Lanes: can't read PaperWM's workspaces: ${e}`);
            }
        }
        return this._activeIndex();
    }

    // Recolour a background made outside the shell's own ones (the hover
    // preview's), showing workspace getIndex()
    track(bgManager, getIndex) {
        this._track(bgManager, getIndex);
    }

    // Call when the workspace a tracked background shows has changed
    refresh(bgManager) {
        if (this._tracked.has(bgManager))
            this._apply(bgManager);
    }

    _track(bgManager, getIndex) {
        if (!bgManager || this._tracked.has(bgManager))
            return;

        // the manager swaps in a new background actor when the wallpaper
        // changes
        const changedId = bgManager.connect('changed', () => this._apply(bgManager));
        this._tracked.set(bgManager, {getIndex, changedId});
        this._apply(bgManager);
    }

    _untrack(bgManager) {
        const entry = this._tracked.get(bgManager);
        if (!entry)
            return;

        bgManager.disconnect(entry.changedId);
        this._tracked.delete(bgManager);
    }

    _apply(bgManager) {
        const actor = bgManager.backgroundActor;
        if (!actor)
            return;

        // a background the scan took for another extension's is the
        // shell's after all
        const destroyId = this._foreign.get(actor);
        if (destroyId) {
            actor.disconnect(destroyId);
            this._foreign.delete(actor);
        }

        const {getIndex} = this._tracked.get(bgManager);
        this._tint(actor, getIndex());
    }

    _applyForeign(actor) {
        this._tint(actor, this._foreignIndex(actor));
    }

    // Recolour @actor in workspace @index's colour, or take the colour off
    // when workspace backgrounds are off
    _tint(actor, index) {
        let effect = actor.get_effect(EFFECT_NAME);
        const style = this._style;
        const strength = this._strength();
        if (style === 'off' || strength === 0) {
            if (effect)
                actor.remove_effect(effect);
            return;
        }

        if (!effect) {
            effect = new TintEffect();
            actor.add_effect_with_name(EFFECT_NAME, effect);
        }

        const custom = this._settings.get_strv('workspace-colors');
        const dark = prefersDark(this._interface);
        // a workspace removed mid-animation has no index any more
        index = Math.max(index, 0);
        effect.setColors(shadesFor(workspaceColor(custom, index), style, dark, strength));
    }

    _applyAll() {
        for (const bgManager of this._tracked.keys())
            this._apply(bgManager);
        for (const actor of this._foreign.keys())
            this._applyForeign(actor);
    }

    destroy() {
        this._destroyed = true;
        this._injections.clear();
        this._interface.disconnectObject(this);
        this._settings.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = 0;

        for (const [container, ids] of this._watched)
            ids.forEach(id => container.disconnect(id));
        this._watched.clear();
        for (const [actor, destroyId] of this._foreign) {
            actor.disconnect(destroyId);
            const effect = actor.get_effect(EFFECT_NAME);
            if (effect)
                actor.remove_effect(effect);
        }
        this._foreign.clear();
        this._paperwm = null;

        for (const [bgManager, {changedId}] of this._tracked) {
            bgManager.disconnect(changedId);
            const effect = bgManager.backgroundActor?.get_effect(EFFECT_NAME);
            if (effect)
                bgManager.backgroundActor.remove_effect(effect);
        }
        this._tracked.clear();
    }
}
