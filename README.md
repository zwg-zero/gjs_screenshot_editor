# Screenshot Editor

A lightweight screenshot capture and annotation tool for GNOME, written in GJS (GNOME JavaScript) with GTK 4. It is designed as a drop-in replacement for Ubuntu's default screenshot utility, adding the editing and annotation capabilities that the default app lacks.

## Features

- **Capture modes** — full screen, selected area, or current window (via `gnome-screenshot`)
- **Open existing images** — PNG, JPEG, BMP, WebP
- **Annotation tools:**
  - Freehand draw
  - Text labels
  - Rectangles
  - Arrows
  - Highlight (semi-transparent fill)
  - Move / reposition any annotation
  - Pan the canvas view
- **Color picker** — 12 preset colors plus a custom color dialog
- **Adjustable stroke width** (1–12 px) and font size (8–72 pt)
- **Zoom** — zoom in/out with buttons, `Ctrl+Scroll`, or keyboard shortcuts; fit-to-window button
- **Undo** — removes the last annotation one step at a time
- **Save** — save with a file chooser dialog or auto-save to `~/Pictures/Screenshots/`
- **Copy to clipboard** — works on both Wayland (`wl-copy`) and X11 (`xclip`)

## Requirements

| Dependency | Purpose |
|---|---|
| `gjs` | JavaScript runtime for GNOME |
| `gtk4` / `libgtk-4` | UI toolkit |
| `gnome-screenshot` | Screenshot capture |
| `wl-clipboard` | Clipboard support on Wayland |
| `xclip` | Clipboard support on X11 |

Install on Ubuntu/Debian:

```bash
sudo apt install gjs libgtk-4-dev gnome-screenshot wl-clipboard xclip
```

## Running

```bash
./run.sh
```

Or run directly with GJS:

```bash
gjs -m screenshot-editor.js
```

## Desktop Integration

### Register the application icon

Install the icon and `.desktop` file for your user (no `sudo` required):

```bash
# Icon
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp icons/hicolor/scalable/apps/com.github.gjs.screenshot-editor.svg \
  ~/.local/share/icons/hicolor/scalable/apps/
gtk-update-icon-cache ~/.local/share/icons/hicolor

# Desktop entry
mkdir -p ~/.local/share/applications
cp com.github.gjs.screenshot-editor.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

Or system-wide (requires `sudo`):

```bash
sudo cp icons/hicolor/scalable/apps/com.github.gjs.screenshot-editor.svg \
  /usr/share/icons/hicolor/scalable/apps/
sudo gtk-update-icon-cache /usr/share/icons/hicolor

sudo cp com.github.gjs.screenshot-editor.desktop /usr/share/applications/
sudo update-desktop-database /usr/share/applications/
```

After running these commands the app and its icon will appear in the application launcher (e.g. GNOME Activities).

To replace the default Ubuntu screenshot shortcut (`PrintScreen`), open **Settings → Keyboard → Keyboard Shortcuts → Screenshots** and point the shortcut to this app's launch command.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` | Undo last annotation |
| `Ctrl+S` | Save (file chooser) |
| `Ctrl+Shift+S` | Quick-save to `~/Pictures/Screenshots/` |
| `Ctrl+Shift+C` | Copy to clipboard |
| `Ctrl+O` | Open image file |
| `Ctrl++` / `Ctrl+=` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+0` | Reset zoom to 100% |
| `Ctrl+Scroll` | Zoom in/out with mouse wheel |

## Project Structure

```
screenshot-editor.js                      # Main application (single file)
run.sh                                    # Convenience launch script
com.github.gjs.screenshot-editor.desktop # Desktop entry for app launcher
icons/
  hicolor/scalable/apps/                  # Application icon (SVG)
```
