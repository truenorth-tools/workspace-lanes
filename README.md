# Workspace Lanes

A taskbar laid out like your desktop: one lane per workspace, with each
lane's windows in the order they sit on screen.

A GNOME Shell 50 extension that replaces the built-in Window List. Windows
are grouped by workspace (1 → n), then ordered left to right on screen,
re-sorting live as you move them.

![Hovering lanes to preview workspaces, jumping to a window from a preview,
and dragging a window so its button re-sorts](screenshots/workspace-lanes-demo.gif)

## Highlights

- **Every window in a predictable place.** Buttons follow your desktop:
  workspace 1's windows first, then each workspace's windows left to
  right as they sit on screen. They re-sort live as you move windows.
- **Scroll through your windows in order.** In the window list layout,
  scrolling on the window list moves focus to the next or previous window
  in the bar's order. At the end of a workspace it carries on into the
  next one and switches to it. Grouped windows are stepped through one at
  a time, and minimized ones are skipped.
- **A colour for every workspace.** The taskbar, top bar, previews,
  wallpaper and even GNOME's accent colour can follow the workspace you're
  on, so you can tell where you are at a glance.
- **An exposé of your own.** Click the current workspace's lane (its
  empty space or number) or switcher thumbnail again to spread its
  windows out over the workspace's wallpaper, in the same order as the
  lane. Click a window to bring it forward, or click the lane again (or
  press Esc) to leave. Scrolling still switches workspace, and the exposé
  follows along. It's separate from GNOME's overview: Super still opens
  that.
- **An applications menu in the corner.** A button at the bottom left
  opens a Start-menu-style list of your favourite apps and apps by
  category (adapted from GNOME's Applications Menu extension, which puts
  it on the top bar).
- **Click to minimize, click to bring back.** Clicking the focused
  window's button minimizes it, and the button keeps its place on the bar.
- **Drag a window to another workspace.** Drop its button on another
  workspace's lane, on a workspace preview, or on a switcher thumbnail.
- **See where Alt+Tab is taking you.** While you switch between an app's
  windows with Alt+` (or between windows with Alt+Tab), the selected
  window's button is highlighted on the taskbar. GNOME's own switcher and
  shortcuts are used as they are.

If you keep lots of windows open across several workspaces and lose track
of them (a common experience with ADHD), Workspace Lanes gives each window
a fixed, visible place. Windows stay in the same order as on screen, and
each workspace has its own colour.

## Two layouts

Switch between them in Settings or by right-clicking empty space on the
bar.

- **Window list**: looks and behaves like GNOME's Window List, with its
  workspace switcher on the right, but uses the ordering described above.
  Empty workspaces take a quarter of the width of ones with windows. Drag
  the divider before the switcher to give it more or less room
  (double-click the divider to reset it). Scrolling over the switcher
  changes workspace.
- **Workspace lanes** (the default): the bar is split into one even-width
  lane per workspace, and each window's button sits in its workspace's
  lane. Crowded lanes collapse in stages: labels shrink, then buttons go
  icon-only, then windows of the same app merge into one icon with a
  count. Hover a lane for a live preview of that workspace. Click a window
  in the preview to jump to it, or click its empty space to switch
  workspace. Clicking empty space in a lane also switches workspace (click
  the current workspace's lane again for the exposé), and scrolling on the
  bar moves between workspaces.

![One lane per workspace, each with its windows in the order they sit
on screen](screenshots/1-lanes.png)

![Hovering the green lane opens a live preview of that
workspace](screenshots/2-hover-preview.png)

![Crowded lanes: full labels, icon-only buttons, and nine Files windows
grouped into one, with the yellow workspace's preview open](screenshots/3-crowded-lanes.png)

![The window list layout, with the workspace switcher on the right and
narrower thumbnails for empty workspaces](screenshots/4-window-list-layout.png)

![Dark style: the teal workspace tints the top bar, its lane and the
wallpaper](screenshots/5-dark-style.png)

Monitors that don't have workspaces (when workspaces are on the primary
monitor only) get a plain list of their own windows, sorted left to right.

## Settings

Open Settings from the Extensions app, or by right-clicking empty space on
the bar. If the settings window is already open, asking for it again
brings it to the front (this also works for other extensions' gear and
Settings buttons in the shell, such as Extension List's).

**Taskbar**

- **Layout**: workspace lanes or window list, how long to hover before a
  preview opens, and whether lanes start with a workspace number.
- **Window grouping**: never, when space is limited (default), or always.
  Grouping stays within each workspace.
- **Applications menu** (on by default): the apps button at the bottom
  left. If you also use GNOME's Applications Menu extension, you can turn
  that off to keep just this one.
- **Click to minimize** (on by default): clicking the focused window's
  button minimizes it, and clicking again brings it back. The button keeps
  its place on the taskbar.
- **Minimize button on windows** (off by default): adds GNOME's minimize
  button to window title bars. This is GNOME's own setting, the same one
  GNOME Tweaks changes, so the switch stays in step with it.
- **Show on all monitors** and **Show windows from all workspaces** (the
  latter for the window list layout).

**Colours**

- **Colour-code workspaces**: each workspace gets its own colour on the
  taskbar, in previews and on the top bar. Pick the colours per workspace.
- **Colour strength**: Off, Subtle, Medium or Strong for the taskbar,
  previews, top bar and backgrounds, set separately for light and dark
  style.
- **Match GNOME's accent colour**: the system accent colour follows the
  current workspace.
- **Workspace backgrounds**: off, a recoloured wallpaper, or a gradient in
  each workspace's colour.
- **Light top bar and menus in Light style**: GNOME's top bar and menus
  follow GNOME Settings' Light/Dark choice instead of staying dark.

**Workspaces**: whether the window list layout's switcher shows previews
or the workspace's name, plus GNOME's workspace options (dynamic or a
fixed number, and workspace names), as in Window List.

In the window list layout, the switcher's width is set by dragging the
divider before it rather than in Settings.

## Install

Workspace Lanes needs GNOME Shell 50.

**From a release:** download
`workspace-lanes@truenorth-tools.shell-extension.zip` from the
[latest release](https://github.com/truenorth-tools/workspace-lanes/releases/latest),
then run:

```bash
gnome-extensions install --force workspace-lanes@truenorth-tools.shell-extension.zip
```

Log out and back in, then (first install only):

```bash
gnome-extensions disable window-list@gnome-shell-extensions.gcampax.github.com
gnome-extensions enable workspace-lanes@truenorth-tools
```

**From a clone of this repository:**

```bash
./install.sh
```

This symlinks `workspace-lanes@truenorth-tools/` into
`~/.local/share/gnome-shell/extensions/`. On Wayland, log out and back in,
then run the script again: it enables Workspace Lanes and disables Window
List. Because it's a symlink, later code edits only need another log out
and back in to take effect.

To go back to Window List:

```bash
gnome-extensions disable workspace-lanes@truenorth-tools
gnome-extensions enable window-list@gnome-shell-extensions.gcampax.github.com
```

## Testing without logging out

Install `mutter-devkit` (e.g. `sudo dnf install mutter-devkit` on Fedora),
then run a GNOME Shell in a window with the extension enabled:

```bash
./test-shell.sh                      # one 1920x1080 monitor
./test-shell.sh 1920x1080 1280x1024  # one monitor per size given
```

It runs with a throwaway home folder and settings, so nothing changed in
it (accent colour, workspaces, extensions) reaches your own session. It
starts from your wallpaper, light/dark style and accent colour, and loads
the extension straight from this folder, so restart it to try code edits.
Close the window or press Ctrl+C to stop it.

## Files

- `extension.js`: window model, ordering, button rows (`ButtonRow`, collapse logic), workspace lanes (`Section`), bar
- `buttons.js`: window and app buttons (from Window List)
- `appsMenu.js`: the applications menu button (from GNOME Shell Extensions' Apps Menu)
- `preview.js`: hover preview of a workspace
- `expose.js`: the exposé (the workspace's windows spread out) opened by clicking the current workspace again
- `switcher.js`: follows the window selected in GNOME's Alt+` and Alt+Tab switchers
- `colors.js`: workspace colour coding (generated stylesheet, top bar tint, accent colour)
- `palette.js`: default colours and colour strengths, shared with the settings window
- `backgrounds.js`: optional per-workspace backgrounds (a shader on the shell's background actors)
- `lightShell.js`: optional light top bar and menus in Light style
- `workspaceIndicator.js`, `workspacePrefs.js`: from Window List (switcher thumbnails and highlighting added, thumbnails sized by use)
- `divider.js`: the draggable divider between the window list and the switcher
- `titleButtons.js`: the Settings switch that adds or removes the minimize button in window title bars
- `settingsWindow.js`: brings an already-open extension settings window forward when its gear or Settings button is used again
- `prefs.js`: settings window (Taskbar and Colours pages; Workspaces page from `workspacePrefs.js`)
- `screenshots/`: images used in this README (not part of the extension)

Licensed GPL-2.0-or-later, as it is derived from GNOME Shell Extensions'
Window List.
