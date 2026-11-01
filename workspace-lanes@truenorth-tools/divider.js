// SPDX-License-Identifier: GPL-2.0-or-later
//
// The handle between the window list and the workspace
// switcher. Dragging it sideways gives the switcher more or less of the
// bar; double-clicking it returns the switcher to its natural width.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export class SwitcherDivider extends St.Widget {
    static [GObject.signals] = {
        // the width (logical px) the switcher should take while dragging
        'drag-width': {param_types: [GObject.TYPE_DOUBLE]},
        // the drag ended; save the last width
        'drag-done': {},
        // double-click: back to the natural width
        'reset': {},
    };

    static {
        GObject.registerClass(this);
    }

    // @getWidth returns the switcher's current logical width
    constructor(getWidth) {
        super({
            style_class: 'lanes-divider',
            reactive: true,
            track_hover: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.set_cursor_type(Clutter.CursorType.EW_RESIZE);

        this.add_child(new St.Widget({
            style_class: 'lanes-divider-grip',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._getWidth = getWidth;
        this._grab = null;
        this.connect('destroy', () => this._endDrag(false));
    }

    get dragging() {
        return !!this._grab;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        // GNOME 50's events don't count clicks, so time them
        const time = event.get_time();
        const {doubleClickTime} = Clutter.Settings.get_default();
        if (this._lastPress !== undefined && time - this._lastPress <= doubleClickTime) {
            this._lastPress = undefined;
            this._endDrag(false);
            this.emit('reset');
            return Clutter.EVENT_STOP;
        }
        this._lastPress = time;

        [this._startX] = event.get_coords();
        this._startWidth = this._getWidth();
        this._grab = global.stage.grab(this);
        this.add_style_pseudo_class('active');
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;

        const [x] = event.get_coords();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // the switcher sits after the divider, so moving the divider
        // towards the start of the bar widens it
        let delta = (this._startX - x) / scale;
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            delta = -delta;
        this.emit('drag-width', this._startWidth + delta);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    _endDrag(save) {
        if (!this._grab)
            return;
        this._grab.dismiss();
        this._grab = null;
        this.remove_style_pseudo_class('active');
        if (save)
            this.emit('drag-done');
    }
}
