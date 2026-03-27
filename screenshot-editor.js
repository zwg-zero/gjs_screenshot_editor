#!/usr/bin/env gjs

'use strict';

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

// ── Tool modes ──────────────────────────────────────────────────────
const Tool = {
    NONE: 0,
    DRAW: 1,
    TEXT: 2,
    RECTANGLE: 3,
    ARROW: 4,
    HIGHLIGHT: 5,
    MOVE: 6,
    PAN: 7,
};

// ── Application ─────────────────────────────────────────────────────
const app = new Gtk.Application({
    application_id: 'com.github.gjs.screenshot-editor',
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

// ── State ───────────────────────────────────────────────────────────
let currentTool = Tool.NONE;
let drawColor = [1, 0, 0, 1]; // RGBA red
let lineWidth = 3;
let fontSize = 20;
let screenshotPixbuf = null;

// Completed annotation layers (each is an object describing the annotation)
let annotations = [];

// In-progress state
let isDrawing = false;
let currentPath = [];       // for freehand
let startX = 0, startY = 0;
let endX = 0, endY = 0;
let pendingText = '';

// Move tool state
let selectedAnnotation = null; // index of selected annotation
let moveOffsetX = 0, moveOffsetY = 0;
let isMoving = false;

// Pan tool state
let isPanning = false;
let panStartHVal = 0, panStartVVal = 0;

// Zoom state
let zoomLevel = 1.0;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;
const ZOOM_STEP = 0.1;

// Canvas widget reference
let canvas = null;
let scrolledWindow = null;
let zoomLabel = null;

// ── Helper: deep-copy color ─────────────────────────────────────────
function copyColor() {
    return [...drawColor];
}

// ── Zoom helpers ────────────────────────────────────────────────────
function applyZoom(newZoom) {
    zoomLevel = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)) * 100) / 100;
    if (zoomLabel) zoomLabel.set_label(`${Math.round(zoomLevel * 100)}%`);
    if (canvas && screenshotPixbuf) {
        canvas.set_content_width(Math.round(screenshotPixbuf.get_width() * zoomLevel));
        canvas.set_content_height(Math.round(screenshotPixbuf.get_height() * zoomLevel));
        canvas.queue_draw();
    }
}

// ── Hit-test: find annotation at (x, y), returns index or -1 ────────
function hitTestAnnotation(x, y) {
    // Search in reverse so topmost annotation is found first
    for (let i = annotations.length - 1; i >= 0; i--) {
        const ann = annotations[i];
        if (ann.type === 'text') {
            // Estimate text bounding box using a temporary surface
            const tmpSurf = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
            const tmpCr = new Cairo.Context(tmpSurf);
            const layout = PangoCairo.create_layout(tmpCr);
            layout.set_font_description(Pango.FontDescription.from_string(`Sans ${ann.fontSize}`));
            layout.set_text(ann.text, -1);
            const [, ext] = layout.get_pixel_extents();
            tmpCr.$dispose();
            tmpSurf.finish();
            if (x >= ann.x && x <= ann.x + ext.width && y >= ann.y && y <= ann.y + ext.height)
                return i;
        } else if (ann.type === 'rectangle' || ann.type === 'highlight') {
            const rx = Math.min(ann.x1, ann.x2);
            const ry = Math.min(ann.y1, ann.y2);
            const rw = Math.abs(ann.x2 - ann.x1);
            const rh = Math.abs(ann.y2 - ann.y1);
            const margin = 8;
            if (x >= rx - margin && x <= rx + rw + margin && y >= ry - margin && y <= ry + rh + margin)
                return i;
        } else if (ann.type === 'arrow') {
            // Distance from point to line segment
            const dx = ann.x2 - ann.x1, dy = ann.y2 - ann.y1;
            const lenSq = dx * dx + dy * dy;
            let t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ann.x1) * dx + (y - ann.y1) * dy) / lenSq));
            const px = ann.x1 + t * dx, py = ann.y1 + t * dy;
            const dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
            if (dist <= 10) return i;
        } else if (ann.type === 'path') {
            for (const pt of ann.points) {
                if (Math.abs(x - pt[0]) <= 8 && Math.abs(y - pt[1]) <= 8)
                    return i;
            }
        }
    }
    return -1;
}

// ── Get bounding center of an annotation (for move offset calc) ─────
function getAnnotationOrigin(ann) {
    if (ann.type === 'text') return { x: ann.x, y: ann.y };
    if (ann.type === 'rectangle' || ann.type === 'highlight' || ann.type === 'arrow')
        return { x: ann.x1, y: ann.y1 };
    if (ann.type === 'path' && ann.points.length > 0)
        return { x: ann.points[0][0], y: ann.points[0][1] };
    return { x: 0, y: 0 };
}

// ── Move an annotation by delta ─────────────────────────────────────
function moveAnnotation(ann, dx, dy) {
    if (ann.type === 'text') {
        ann.x += dx;
        ann.y += dy;
    } else if (ann.type === 'rectangle' || ann.type === 'highlight' || ann.type === 'arrow') {
        ann.x1 += dx; ann.y1 += dy;
        ann.x2 += dx; ann.y2 += dy;
    } else if (ann.type === 'path') {
        for (const pt of ann.points) {
            pt[0] += dx;
            pt[1] += dy;
        }
    }
}

// ── Capture screenshot via gnome-screenshot or grim ─────────────────
function captureScreenshot(mode, window) {
    // mode: 'full' | 'area' | 'window'
    const timestamp = GLib.DateTime.new_now_local().format('%Y%m%d_%H%M%S');
    const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), `screenshot_${timestamp}.png`]);

    let argv;
    // Try gnome-screenshot first (X11/Wayland with GNOME)
    if (mode === 'full') {
        argv = ['gnome-screenshot', '-f', tmpPath];
    } else if (mode === 'area') {
        argv = ['gnome-screenshot', '-a', '-f', tmpPath];
    } else if (mode === 'window') {
        argv = ['gnome-screenshot', '-w', '-f', tmpPath];
    }

    try {
        let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        proc.wait(null);
        if (proc.get_exit_status() !== 0) {
            showError(window, 'Screenshot command failed. Make sure gnome-screenshot is installed.');
            return;
        }
    } catch (e) {
        showError(window, `Failed to run screenshot tool: ${e.message}\nInstall with: sudo apt install gnome-screenshot`);
        return;
    }

    try {
        screenshotPixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpPath);
        annotations = [];
        // Resize canvas to image size (accounting for zoom)
        if (canvas) {
            canvas.set_content_width(Math.round(screenshotPixbuf.get_width() * zoomLevel));
            canvas.set_content_height(Math.round(screenshotPixbuf.get_height() * zoomLevel));
            canvas.queue_draw();
        }
    } catch (e) {
        showError(window, `Failed to load screenshot: ${e.message}`);
    }
}

// ── Load image from file ────────────────────────────────────────────
function loadImageFile(window) {
    const dialog = new Gtk.FileDialog();
    const filter = new Gtk.FileFilter();
    filter.add_mime_type('image/png');
    filter.add_mime_type('image/jpeg');
    filter.add_mime_type('image/bmp');
    filter.add_mime_type('image/webp');
    filter.set_name('Images');
    const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype);
    filters.append(filter);
    dialog.set_filters(filters);

    dialog.open(window, null, (self, result) => {
        try {
            const file = dialog.open_finish(result);
            if (file) {
                screenshotPixbuf = GdkPixbuf.Pixbuf.new_from_file(file.get_path());
                annotations = [];
                canvas.set_content_width(Math.round(screenshotPixbuf.get_width() * zoomLevel));
                canvas.set_content_height(Math.round(screenshotPixbuf.get_height() * zoomLevel));
                canvas.queue_draw();
            }
        } catch (e) {
            if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                showError(window, `Failed to open image: ${e.message}`);
        }
    });
}

// ── Save image ──────────────────────────────────────────────────────
function saveImage(window) {
    if (!screenshotPixbuf) {
        showError(window, 'No image to save. Take a screenshot first.');
        return;
    }

    const dialog = new Gtk.FileDialog();
    dialog.set_initial_name('screenshot.png');

    dialog.save(window, null, (self, result) => {
        try {
            const file = dialog.save_finish(result);
            if (!file) return;
            const path = file.get_path();

            // Render final image with annotations
            const width = screenshotPixbuf.get_width();
            const height = screenshotPixbuf.get_height();
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
            const cr = new Cairo.Context(surface);

            // Draw base image
            Gdk.cairo_set_source_pixbuf(cr, screenshotPixbuf, 0, 0);
            cr.paint();

            // Draw annotations
            renderAnnotations(cr);

            cr.$dispose();
            surface.writeToPNG(path);
            surface.finish();
        } catch (e) {
            if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                showError(window, `Failed to save: ${e.message}`);
        }
    });
}

// ── Save to file (default: ~/Pictures/Screenshots) ──────────────────
const DEFAULT_SAVE_DIR = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'Screenshots']);

function saveToFile(window) {
    if (!screenshotPixbuf) {
        showError(window, 'No image to save. Take a screenshot first.');
        return;
    }

    // Ensure the directory exists
    const dir = Gio.File.new_for_path(DEFAULT_SAVE_DIR);
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        // Ignore if directory already exists
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))  {
            showError(window, `Failed to create directory: ${e.message}`);
            return;
        }
    }

    const timestamp = GLib.DateTime.new_now_local().format('%Y%m%d_%H%M%S');
    const filename = `screenshot_${timestamp}.png`;
    const path = GLib.build_filenamev([DEFAULT_SAVE_DIR, filename]);

    // Render final image with annotations
    const width = screenshotPixbuf.get_width();
    const height = screenshotPixbuf.get_height();
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);

    Gdk.cairo_set_source_pixbuf(cr, screenshotPixbuf, 0, 0);
    cr.paint();
    renderAnnotations(cr);

    cr.$dispose();
    surface.writeToPNG(path);
    surface.finish();

    // Show a brief notification via info dialog
    const dialog = new Gtk.AlertDialog();
    dialog.set_message('Saved');
    dialog.set_detail(`Image saved to:\n${path}`);
    dialog.show(window);
}

// ── Copy to clipboard ────────────────────────────────────────────────
function copyToClipboard(window) {
    if (!screenshotPixbuf) {
        showError(window, 'No image to copy. Take a screenshot first.');
        return;
    }

    // Render final image with annotations
    const width = screenshotPixbuf.get_width();
    const height = screenshotPixbuf.get_height();
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);

    Gdk.cairo_set_source_pixbuf(cr, screenshotPixbuf, 0, 0);
    cr.paint();
    renderAnnotations(cr);
    cr.$dispose();

    // Write to a temporary PNG file
    const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), `clipboard_${GLib.get_monotonic_time()}.png`]);
    surface.writeToPNG(tmpPath);
    surface.finish();

    // Use wl-copy (Wayland) or xclip (X11) to set clipboard
    let argv;
    const sessionType = GLib.getenv('XDG_SESSION_TYPE');
    if (sessionType === 'wayland') {
        argv = ['wl-copy', '--type', 'image/png'];
    } else {
        argv = ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i', tmpPath];
    }

    try {
        if (sessionType === 'wayland') {
            // wl-copy reads from stdin, so pipe the file content
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDIN_PIPE,
            });
            proc.init(null);
            const [, pngData] = GLib.file_get_contents(tmpPath);
            const stdin = proc.get_stdin_pipe();
            stdin.write_bytes(GLib.Bytes.new(pngData), null);
            stdin.close(null);
            proc.wait(null);
        } else {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait(null);
        }
    } catch (e) {
        GLib.unlink(tmpPath);
        showError(window, `Failed to copy to clipboard: ${e.message}\n\nInstall clipboard tool:\n  Wayland: sudo apt install wl-clipboard\n  X11: sudo apt install xclip`);
        return;
    }

    GLib.unlink(tmpPath);
}

// ── Error dialog ────────────────────────────────────────────────────
function showError(window, message) {
    const dialog = new Gtk.AlertDialog();
    dialog.set_message('Error');
    dialog.set_detail(message);
    dialog.show(window);
}

// ── Render all annotations onto a Cairo context ─────────────────────
function renderAnnotations(cr) {
    for (const ann of annotations) {
        cr.save();
        cr.setSourceRGBA(ann.color[0], ann.color[1], ann.color[2], ann.color[3]);

        switch (ann.type) {
            case 'path': {
                if (ann.points.length < 2) break;
                cr.setLineWidth(ann.lineWidth);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(ann.points[0][0], ann.points[0][1]);
                for (let i = 1; i < ann.points.length; i++)
                    cr.lineTo(ann.points[i][0], ann.points[i][1]);
                cr.stroke();
                break;
            }
            case 'rectangle': {
                cr.setLineWidth(ann.lineWidth);
                const x = Math.min(ann.x1, ann.x2);
                const y = Math.min(ann.y1, ann.y2);
                const w = Math.abs(ann.x2 - ann.x1);
                const h = Math.abs(ann.y2 - ann.y1);
                cr.rectangle(x, y, w, h);
                cr.stroke();
                break;
            }
            case 'arrow': {
                cr.setLineWidth(ann.lineWidth);
                cr.moveTo(ann.x1, ann.y1);
                cr.lineTo(ann.x2, ann.y2);
                cr.stroke();
                // Arrowhead
                const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
                const headLen = 15 + ann.lineWidth * 2;
                cr.moveTo(ann.x2, ann.y2);
                cr.lineTo(
                    ann.x2 - headLen * Math.cos(angle - 0.4),
                    ann.y2 - headLen * Math.sin(angle - 0.4)
                );
                cr.moveTo(ann.x2, ann.y2);
                cr.lineTo(
                    ann.x2 - headLen * Math.cos(angle + 0.4),
                    ann.y2 - headLen * Math.sin(angle + 0.4)
                );
                cr.stroke();
                break;
            }
            case 'highlight': {
                cr.setSourceRGBA(ann.color[0], ann.color[1], ann.color[2], 0.3);
                const hx = Math.min(ann.x1, ann.x2);
                const hy = Math.min(ann.y1, ann.y2);
                const hw = Math.abs(ann.x2 - ann.x1);
                const hh = Math.abs(ann.y2 - ann.y1);
                cr.rectangle(hx, hy, hw, hh);
                cr.fill();
                break;
            }
            case 'text': {
                const layout = PangoCairo.create_layout(cr);
                const desc = Pango.FontDescription.from_string(`Sans ${ann.fontSize}`);
                layout.set_font_description(desc);
                layout.set_text(ann.text, -1);
                cr.moveTo(ann.x, ann.y);
                PangoCairo.show_layout(cr, layout);
                break;
            }
        }
        cr.restore();
    }
}

// ── Render in-progress shape ────────────────────────────────────────
function renderInProgress(cr) {
    if (!isDrawing) return;
    cr.save();
    cr.setSourceRGBA(drawColor[0], drawColor[1], drawColor[2], drawColor[3]);

    if (currentTool === Tool.DRAW && currentPath.length >= 2) {
        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.moveTo(currentPath[0][0], currentPath[0][1]);
        for (let i = 1; i < currentPath.length; i++)
            cr.lineTo(currentPath[i][0], currentPath[i][1]);
        cr.stroke();
    } else if (currentTool === Tool.RECTANGLE) {
        cr.setLineWidth(lineWidth);
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        cr.rectangle(x, y, Math.abs(endX - startX), Math.abs(endY - startY));
        cr.stroke();
    } else if (currentTool === Tool.ARROW) {
        cr.setLineWidth(lineWidth);
        cr.moveTo(startX, startY);
        cr.lineTo(endX, endY);
        cr.stroke();
        const angle = Math.atan2(endY - startY, endX - startX);
        const headLen = 15 + lineWidth * 2;
        cr.moveTo(endX, endY);
        cr.lineTo(endX - headLen * Math.cos(angle - 0.4), endY - headLen * Math.sin(angle - 0.4));
        cr.moveTo(endX, endY);
        cr.lineTo(endX - headLen * Math.cos(angle + 0.4), endY - headLen * Math.sin(angle + 0.4));
        cr.stroke();
    } else if (currentTool === Tool.HIGHLIGHT) {
        cr.setSourceRGBA(drawColor[0], drawColor[1], drawColor[2], 0.3);
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        cr.rectangle(x, y, Math.abs(endX - startX), Math.abs(endY - startY));
        cr.fill();
    }
    cr.restore();
}

// ── Text input dialog ───────────────────────────────────────────────
function showTextDialog(window, x, y) {
    const dialog = new Gtk.Window({
        title: 'Add Text',
        modal: true,
        transient_for: window,
        default_width: 350,
        default_height: 150,
    });

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, margin_top: 15, margin_bottom: 15, margin_start: 15, margin_end: 15 });

    const entry = new Gtk.Entry({ placeholder_text: 'Type your text here...' });
    entry.set_hexpand(true);

    const btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, halign: Gtk.Align.END });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    const okBtn = new Gtk.Button({ label: 'Add', css_classes: ['suggested-action'] });

    cancelBtn.connect('clicked', () => dialog.close());
    okBtn.connect('clicked', () => {
        const text = entry.get_text().trim();
        if (text) {
            annotations.push({
                type: 'text',
                text,
                x, y,
                fontSize,
                color: copyColor(),
            });
            canvas.queue_draw();
        }
        dialog.close();
    });

    entry.connect('activate', () => okBtn.emit('clicked'));

    btnBox.append(cancelBtn);
    btnBox.append(okBtn);
    box.append(entry);
    box.append(btnBox);
    dialog.set_child(box);
    dialog.present();
}

// ── Capture flow: hide app, take screenshot, then bring app to front ──
function runCaptureFlow(mode, window) {
    window.set_visible(false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        captureScreenshot(mode, window);
        window.set_visible(true);
        window.set_keep_above(true);
        window.present();
        window.grab_focus();

        // Drop keep-above shortly after presenting so normal stacking resumes.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            window.set_keep_above(false);
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
}

// ── Startup: prompt user to choose a screenshot type ───────────────
function showCaptureModeDialog(window) {
    const dialog = new Gtk.Window({
        title: 'Take a Screenshot',
        modal: true,
        transient_for: window,
        resizable: false,
        default_width: 340,
    });

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
    });

    const title = new Gtk.Label({
        label: '<b>How would you like to capture?</b>',
        use_markup: true,
        margin_bottom: 4,
    });
    box.append(title);

    const modes = [
        { label: 'Full Screen',       icon: 'video-display-symbolic',   mode: 'full'   },
        { label: 'Select Area',       icon: 'edit-select-all-symbolic',  mode: 'area'   },
        { label: 'Current Window',    icon: 'window-restore-symbolic',   mode: 'window' },
    ];

    for (const m of modes) {
        const btn = new Gtk.Button({
            tooltip_text: m.label,
            hexpand: true,
        });
        const btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
        btnBox.append(new Gtk.Image({ icon_name: m.icon, icon_size: Gtk.IconSize.NORMAL }));
        btnBox.append(new Gtk.Label({ label: m.label, xalign: 0, hexpand: true }));
        btn.set_child(btnBox);
        btn.connect('clicked', () => {
            dialog.close();
            runCaptureFlow(m.mode, window);
        });
        box.append(btn);
    }

    const skipBtn = new Gtk.Button({ label: 'Open Image Instead', css_classes: ['flat'] });
    skipBtn.connect('clicked', () => {
        dialog.close();
        loadImageFile(window);
    });
    box.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 4, margin_bottom: 4 }));
    box.append(skipBtn);

    dialog.set_child(box);
    dialog.present();
}

// ── Build UI ────────────────────────────────────────────────────────
app.connect('activate', () => {
    // Register custom icon search path
    const scriptFile = Gio.File.new_for_uri(import.meta.url);
    const scriptDir = scriptFile.get_parent().get_path();
    const iconDir = GLib.build_filenamev([scriptDir, 'icons']);
    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    iconTheme.add_search_path(iconDir);

    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Screenshot Editor',
        default_width: 1000,
        default_height: 700,
    });

    // ── Header bar ──────────────────────────────────────────────────
    const headerBar = new Gtk.HeaderBar();

    // Screenshot capture buttons
    const captureFullBtn = new Gtk.Button({ icon_name: 'video-display-symbolic', tooltip_text: 'Capture Full Screen' });
    captureFullBtn.connect('clicked', () => {
        runCaptureFlow('full', window);
    });
    headerBar.pack_start(captureFullBtn);

    const captureAreaBtn = new Gtk.Button({ icon_name: 'edit-select-all-symbolic', tooltip_text: 'Capture Selected Area' });
    captureAreaBtn.connect('clicked', () => {
        runCaptureFlow('area', window);
    });
    headerBar.pack_start(captureAreaBtn);

    const captureWindowBtn = new Gtk.Button({ icon_name: 'window-restore-symbolic', tooltip_text: 'Capture Current Window' });
    captureWindowBtn.connect('clicked', () => {
        runCaptureFlow('window', window);
    });
    headerBar.pack_start(captureWindowBtn);

    const openBtn = new Gtk.Button({ icon_name: 'document-open-symbolic', tooltip_text: 'Open Image' });
    openBtn.connect('clicked', () => loadImageFile(window));
    headerBar.pack_start(openBtn);

    const saveBtn = new Gtk.Button({ icon_name: 'document-save-symbolic', tooltip_text: 'Save Image (Ctrl+S)' });
    saveBtn.connect('clicked', () => saveImage(window));
    headerBar.pack_end(saveBtn);

    const saveFileBtn = new Gtk.Button({ icon_name: 'document-save-as-symbolic', tooltip_text: 'Save to ~/Pictures/Screenshots (Ctrl+Shift+S)' });
    saveFileBtn.connect('clicked', () => saveToFile(window));
    headerBar.pack_end(saveFileBtn);

    const copyBtn = new Gtk.Button({ icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy to Clipboard (Ctrl+Shift+C)' });
    copyBtn.connect('clicked', () => copyToClipboard(window));
    headerBar.pack_end(copyBtn);

    const undoBtn = new Gtk.Button({ icon_name: 'edit-undo-symbolic', tooltip_text: 'Undo' });
    undoBtn.connect('clicked', () => {
        if (annotations.length > 0) {
            annotations.pop();
            canvas.queue_draw();
        }
    });
    headerBar.pack_end(undoBtn);

    window.set_icon_name('com.github.gjs.screenshot-editor');
    window.set_titlebar(headerBar);

    // (Capture screenshot actions are now handled directly by header bar buttons)

    // ── Main layout ─────────────────────────────────────────────────
    const mainBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });

    // ── Toolbar (left side) ─────────────────────────────────────────
    const toolbar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 6,
        margin_end: 6,
        width_request: 48,
    });

    // Tool buttons
    const tools = [
        { name: 'Draw', icon: 'edit-symbolic', tool: Tool.DRAW },
        { name: 'Text', icon: 'font-x-generic-symbolic', tool: Tool.TEXT },
        { name: 'Rectangle', icon: 'checkbox-symbolic', tool: Tool.RECTANGLE },
        { name: 'Arrow', icon: null, tool: Tool.ARROW },
        { name: 'Highlight', icon: null, tool: Tool.HIGHLIGHT },
        { name: 'Move', icon: 'hand-open-symbolic', tool: Tool.MOVE },
        { name: 'Pan', icon: null, tool: Tool.PAN },
    ];

    let toolButtons = [];
    for (const t of tools) {
        const btn = new Gtk.ToggleButton({
            tooltip_text: t.name,
            has_frame: true,
        });
        if (t.icon) {
            btn.set_icon_name(t.icon);
        } else if (t.tool === Tool.PAN) {
            const panIcon = new Gtk.DrawingArea({
                content_width: 16,
                content_height: 16,
            });
            panIcon.set_draw_func((area, cr, w, h) => {
                const cx = w / 2;
                const cy = h / 2;
                const arm = Math.min(w, h) * 0.32;
                const head = 2.8;

                cr.setSourceRGBA(0.2, 0.2, 0.2, 0.95);
                cr.setLineWidth(1.6);
                cr.setLineCap(Cairo.LineCap.ROUND);

                // Four-way pan glyph: a cross with arrow tips.
                cr.moveTo(cx - arm, cy);
                cr.lineTo(cx + arm, cy);
                cr.moveTo(cx, cy - arm);
                cr.lineTo(cx, cy + arm);
                cr.stroke();

                cr.moveTo(cx + arm, cy);
                cr.lineTo(cx + arm - head, cy - head);
                cr.moveTo(cx + arm, cy);
                cr.lineTo(cx + arm - head, cy + head);

                cr.moveTo(cx - arm, cy);
                cr.lineTo(cx - arm + head, cy - head);
                cr.moveTo(cx - arm, cy);
                cr.lineTo(cx - arm + head, cy + head);

                cr.moveTo(cx, cy - arm);
                cr.lineTo(cx - head, cy - arm + head);
                cr.moveTo(cx, cy - arm);
                cr.lineTo(cx + head, cy - arm + head);

                cr.moveTo(cx, cy + arm);
                cr.lineTo(cx - head, cy + arm - head);
                cr.moveTo(cx, cy + arm);
                cr.lineTo(cx + head, cy + arm - head);
                cr.stroke();
            });
            btn.set_child(panIcon);
        } else if (t.tool === Tool.ARROW) {
            const arrowIcon = new Gtk.DrawingArea({
                content_width: 16,
                content_height: 16,
            });
            arrowIcon.set_draw_func((area, cr, w, h) => {
                cr.setSourceRGBA(0.2, 0.2, 0.2, 0.95);
                cr.setLineWidth(1.2);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                // Shaft: bottom-left to upper-right
                const x1 = w * 0.36, y1 = h * 0.68;
                const x2 = w * 0.68, y2 = h * 0.36;
                cr.moveTo(x1, y1);
                cr.lineTo(x2, y2);
                cr.stroke();
                // Arrowhead at (x2, y2)
                const angle = Math.atan2(y2 - y1, x2 - x1);
                const headLen = Math.min(w, h) * 0.22;
                const headAngle = Math.PI / 6;
                cr.moveTo(x2, y2);
                cr.lineTo(x2 - headLen * Math.cos(angle - headAngle),
                          y2 - headLen * Math.sin(angle - headAngle));
                cr.moveTo(x2, y2);
                cr.lineTo(x2 - headLen * Math.cos(angle + headAngle),
                          y2 - headLen * Math.sin(angle + headAngle));
                cr.stroke();
            });
            btn.set_child(arrowIcon);
        } else if (t.tool === Tool.HIGHLIGHT) {
            const highlightIcon = new Gtk.DrawingArea({
                content_width: 16,
                content_height: 16,
            });
            highlightIcon.set_draw_func((area, cr, w, h) => {
                cr.setSourceRGBA(1, 0, 0, 0.45);
                cr.rectangle(1, 1, w - 2, h - 2);
                cr.fill();
                cr.setSourceRGBA(1, 0, 0, 0.9);
                cr.setLineWidth(1.5);
                cr.rectangle(1, 1, w - 2, h - 2);
                cr.stroke();
            });
            btn.set_child(highlightIcon);
        }
        btn._tool = t.tool;
        btn.connect('toggled', () => {
            if (btn.get_active()) {
                currentTool = t.tool;
                // Uncheck others
                for (const other of toolButtons) {
                    if (other !== btn) other.set_active(false);
                }
            } else {
                if (currentTool === t.tool) currentTool = Tool.NONE;
            }
        });
        toolbar.append(btn);
        toolButtons.push(btn);
    }

    // Separator
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 6, margin_bottom: 6 }));

    // Color palette (compact grid)
    const colorLabel = new Gtk.Label({ label: 'Color', css_classes: ['dim-label'] });
    toolbar.append(colorLabel);

    const colors = [
        // Row 1
        [0, 0, 0, 1],       [0.4, 0.4, 0.4, 1], [1, 1, 1, 1],
        // Row 2
        [1, 0, 0, 1],       [0, 0.7, 0, 1],     [0, 0.4, 1, 1],
        // Row 3
        [1, 1, 0, 1],       [1, 0.5, 0, 1],      [0.6, 0, 0.8, 1],
        // Row 4
        [1, 0.7, 0.7, 1],   [0.5, 0.85, 0.5, 1], [0.5, 0.75, 1, 1],
    ];
    const GRID_COLS = 3;

    const colorGrid = new Gtk.Grid({
        row_spacing: 2,
        column_spacing: 2,
    });

    let colorButtons = [];
    for (let i = 0; i < colors.length; i++) {
        const c = colors[i];
        const btn = new Gtk.ToggleButton({
            width_request: 14,
            height_request: 14,
        });

        const cssProvider = new Gtk.CssProvider();
        const rgbaStr = `rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${c[3]})`;
        cssProvider.load_from_string(`
            button { background: ${rgbaStr}; min-width: 14px; min-height: 14px; border-radius: 2px; padding: 0; border: 1px solid alpha(black, 0.3); }
            button:checked { border: 2px solid @accent_color; }
        `);
        btn.get_style_context().add_provider(cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        btn.connect('toggled', () => {
            if (btn.get_active()) {
                drawColor = [...c];
                for (const other of colorButtons) {
                    if (other !== btn) other.set_active(false);
                }
            }
        });
        colorGrid.attach(btn, i % GRID_COLS, Math.floor(i / GRID_COLS), 1, 1);
        colorButtons.push(btn);
    }
    toolbar.append(colorGrid);

    // Custom color button using GTK ColorDialog
    const customColorBtn = new Gtk.Button({ label: '...', tooltip_text: 'Custom Color' });
    const customCss = new Gtk.CssProvider();
    customCss.load_from_string('button { min-height: 10px; padding: 0 4px; font-size: 10px; }');
    customColorBtn.get_style_context().add_provider(customCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    customColorBtn.connect('clicked', () => {
        const colorDialog = new Gtk.ColorDialog();
        const initColor = new Gdk.RGBA();
        initColor.red = drawColor[0];
        initColor.green = drawColor[1];
        initColor.blue = drawColor[2];
        initColor.alpha = drawColor[3];
        colorDialog.choose_rgba(window, initColor, null, (self, result) => {
            try {
                const rgba = colorDialog.choose_rgba_finish(result);
                drawColor = [rgba.red, rgba.green, rgba.blue, rgba.alpha];
                // Deselect all grid buttons
                for (const btn of colorButtons) btn.set_active(false);
            } catch (e) {
                // User cancelled
            }
        });
    });
    toolbar.append(customColorBtn);

    // Default: select red
    colorButtons[3].set_active(true);

    // Separator
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 6, margin_bottom: 6 }));

    // Line width
    const sizeLabel = new Gtk.Label({ label: 'Size', css_classes: ['dim-label'] });
    toolbar.append(sizeLabel);

    const sizeScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 12, step_increment: 1, value: 3 }),
        draw_value: false,
        width_request: 40,
    });
    sizeScale.connect('value-changed', () => {
        lineWidth = sizeScale.get_value();
    });
    toolbar.append(sizeScale);

    // Font size
    const fontLabel = new Gtk.Label({ label: 'Font', css_classes: ['dim-label'] });
    toolbar.append(fontLabel);

    const fontSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 8, upper: 72, step_increment: 2, value: 20 }),
        width_request: 40,
    });
    fontSpin.connect('value-changed', () => {
        fontSize = fontSpin.get_value_as_int();
    });
    toolbar.append(fontSpin);

    // Clear all button
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 6, margin_bottom: 6 }));
    const clearBtn = new Gtk.Button({ icon_name: 'edit-clear-all-symbolic', tooltip_text: 'Clear All Annotations' });
    clearBtn.connect('clicked', () => {
        annotations = [];
        canvas.queue_draw();
    });
    toolbar.append(clearBtn);

    // Zoom controls
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 6, margin_bottom: 6 }));

    const zoomInBtn = new Gtk.Button({ icon_name: 'zoom-in-symbolic', tooltip_text: 'Zoom In (Ctrl++)' });
    zoomInBtn.connect('clicked', () => applyZoom(zoomLevel + ZOOM_STEP));
    toolbar.append(zoomInBtn);

    const zoomOutBtn = new Gtk.Button({ icon_name: 'zoom-out-symbolic', tooltip_text: 'Zoom Out (Ctrl+-)' });
    zoomOutBtn.connect('clicked', () => applyZoom(zoomLevel - ZOOM_STEP));
    toolbar.append(zoomOutBtn);

    zoomLabel = new Gtk.Label({ label: '100%', css_classes: ['dim-label'] });
    toolbar.append(zoomLabel);

    const zoomResetBtn = new Gtk.Button({ label: 'Reset', tooltip_text: 'Reset Zoom to 100%' });
    zoomResetBtn.connect('clicked', () => applyZoom(1.0));
    toolbar.append(zoomResetBtn);

    const zoomFitBtn = new Gtk.Button({ label: 'Fit', tooltip_text: 'Fit to Window' });
    zoomFitBtn.connect('clicked', () => {
        if (!screenshotPixbuf || !scrolledWindow) return;
        const sw = scrolledWindow.get_width() - 2;
        const sh = scrolledWindow.get_height() - 2;
        const iw = screenshotPixbuf.get_width();
        const ih = screenshotPixbuf.get_height();
        if (iw > 0 && ih > 0)
            applyZoom(Math.min(sw / iw, sh / ih));
    });
    toolbar.append(zoomFitBtn);

    mainBox.append(toolbar);
    mainBox.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));

    // ── Canvas area ─────────────────────────────────────────────────
    canvas = new Gtk.DrawingArea();
    canvas.set_content_width(800);
    canvas.set_content_height(600);

    canvas.set_draw_func((area, cr, width, height) => {
        // Background checkerboard (transparent indicator)
        cr.setSourceRGBA(0.85, 0.85, 0.85, 1);
        cr.paint();
        const tileSize = 16;
        cr.setSourceRGBA(0.75, 0.75, 0.75, 1);
        for (let y = 0; y < height; y += tileSize) {
            for (let x = 0; x < width; x += tileSize) {
                if ((Math.floor(x / tileSize) + Math.floor(y / tileSize)) % 2 === 0)
                    cr.rectangle(x, y, tileSize, tileSize);
            }
        }
        cr.fill();

        // Apply zoom transform
        cr.scale(zoomLevel, zoomLevel);

        // Draw screenshot
        if (screenshotPixbuf) {
            Gdk.cairo_set_source_pixbuf(cr, screenshotPixbuf, 0, 0);
            cr.paint();
        } else {
            // Placeholder text
            cr.setSourceRGBA(0.5, 0.5, 0.5, 1);
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(Pango.FontDescription.from_string('Sans 16'));
            layout.set_text('Click the camera icon to take a screenshot\nor open an existing image', -1);
            layout.set_alignment(Pango.Alignment.CENTER);
            const [, extents] = layout.get_pixel_extents();
            cr.moveTo((width - extents.width) / 2, (height - extents.height) / 2);
            PangoCairo.show_layout(cr, layout);
        }

        // Draw completed annotations
        renderAnnotations(cr);

        // Draw in-progress annotation
        renderInProgress(cr);

        // Draw selection highlight around selected annotation
        if (selectedAnnotation !== null && selectedAnnotation >= 0 && selectedAnnotation < annotations.length) {
            const ann = annotations[selectedAnnotation];
            cr.save();
            cr.setSourceRGBA(0.2, 0.5, 1, 0.8);
            cr.setLineWidth(2);
            cr.setDash([6, 4], 0);
            let sx, sy, sw, sh;
            if (ann.type === 'text') {
                const layout = PangoCairo.create_layout(cr);
                layout.set_font_description(Pango.FontDescription.from_string(`Sans ${ann.fontSize}`));
                layout.set_text(ann.text, -1);
                const [, ext] = layout.get_pixel_extents();
                sx = ann.x - 4; sy = ann.y - 4;
                sw = ext.width + 8; sh = ext.height + 8;
            } else if (ann.type === 'rectangle' || ann.type === 'highlight') {
                sx = Math.min(ann.x1, ann.x2) - 4;
                sy = Math.min(ann.y1, ann.y2) - 4;
                sw = Math.abs(ann.x2 - ann.x1) + 8;
                sh = Math.abs(ann.y2 - ann.y1) + 8;
            } else if (ann.type === 'arrow') {
                sx = Math.min(ann.x1, ann.x2) - 4;
                sy = Math.min(ann.y1, ann.y2) - 4;
                sw = Math.abs(ann.x2 - ann.x1) + 8;
                sh = Math.abs(ann.y2 - ann.y1) + 8;
            } else if (ann.type === 'path' && ann.points.length > 0) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const pt of ann.points) {
                    minX = Math.min(minX, pt[0]); minY = Math.min(minY, pt[1]);
                    maxX = Math.max(maxX, pt[0]); maxY = Math.max(maxY, pt[1]);
                }
                sx = minX - 4; sy = minY - 4;
                sw = maxX - minX + 8; sh = maxY - minY + 8;
            }
            if (sw !== undefined) cr.rectangle(sx, sy, sw, sh);
            cr.stroke();
            cr.restore();
        }
    });

    // ── Input handling ──────────────────────────────────────────────
    const clickGesture = new Gtk.GestureClick();
    clickGesture.connect('pressed', (gesture, nPress, rawX, rawY) => {
        const x = rawX / zoomLevel;
        const y = rawY / zoomLevel;
        if (!screenshotPixbuf || currentTool === Tool.NONE) return;

        if (currentTool === Tool.PAN) return;

        if (currentTool === Tool.MOVE) {
            const idx = hitTestAnnotation(x, y);
            if (idx >= 0) {
                selectedAnnotation = idx;
                isMoving = true;
                const origin = getAnnotationOrigin(annotations[idx]);
                moveOffsetX = x - origin.x;
                moveOffsetY = y - origin.y;
                startX = x;
                startY = y;
                canvas.queue_draw();
            } else {
                selectedAnnotation = null;
                canvas.queue_draw();
            }
            return;
        }

        // Deselect when using other tools
        selectedAnnotation = null;

        if (currentTool === Tool.TEXT) {
            showTextDialog(window, x, y);
            return;
        }

        isDrawing = true;
        startX = x;
        startY = y;
        endX = x;
        endY = y;

        if (currentTool === Tool.DRAW) {
            currentPath = [[x, y]];
        }
    });

    clickGesture.connect('released', (gesture, nPress, rawX, rawY) => {
        if (isMoving) {
            isMoving = false;
            return;
        }

        if (!isDrawing) return;
        isDrawing = false;

        if (currentTool === Tool.DRAW && currentPath.length >= 2) {
            annotations.push({ type: 'path', points: [...currentPath], lineWidth, color: copyColor() });
        } else if (currentTool === Tool.RECTANGLE) {
            annotations.push({ type: 'rectangle', x1: startX, y1: startY, x2: endX, y2: endY, lineWidth, color: copyColor() });
        } else if (currentTool === Tool.ARROW) {
            annotations.push({ type: 'arrow', x1: startX, y1: startY, x2: endX, y2: endY, lineWidth, color: copyColor() });
        } else if (currentTool === Tool.HIGHLIGHT) {
            annotations.push({ type: 'highlight', x1: startX, y1: startY, x2: endX, y2: endY, color: copyColor() });
        }

        currentPath = [];
        canvas.queue_draw();
    });

    const dragGesture = new Gtk.GestureDrag();
    dragGesture.connect('drag-update', (gesture, rawOffsetX, rawOffsetY) => {
        const offsetX = rawOffsetX / zoomLevel;
        const offsetY = rawOffsetY / zoomLevel;
        if (isMoving && selectedAnnotation !== null) {
            const ann = annotations[selectedAnnotation];
            // Use absolute position: move to where the cursor is minus the grab offset
            const origin = getAnnotationOrigin(ann);
            const targetX = startX + offsetX - moveOffsetX;
            const targetY = startY + offsetY - moveOffsetY;
            const moveDx = targetX - origin.x;
            const moveDy = targetY - origin.y;
            moveAnnotation(ann, moveDx, moveDy);
            canvas.queue_draw();
            return;
        }

        if (!isDrawing) return;
        endX = startX + offsetX;
        endY = startY + offsetY;

        if (currentTool === Tool.DRAW) {
            currentPath.push([endX, endY]);
        }
        canvas.queue_draw();
    });

    // Ctrl+scroll to zoom
    const scrollController = new Gtk.EventControllerScroll({
        flags: Gtk.EventControllerScrollFlags.VERTICAL,
    });
    scrollController.connect('scroll', (controller, dx, dy) => {
        const state = controller.get_current_event_state();
        if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0) {
            applyZoom(zoomLevel - dy * ZOOM_STEP);
            return true;
        }
        return false;
    });

    canvas.add_controller(clickGesture);
    canvas.add_controller(dragGesture);

    // ── Scrolled window for large screenshots ───────────────────────
    scrolledWindow = new Gtk.ScrolledWindow({
        hexpand: true,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.ALWAYS,
        vscrollbar_policy: Gtk.PolicyType.ALWAYS,
    });
    scrolledWindow.set_child(canvas);

    // Ctrl+scroll to zoom (on scrolled window so it captures events before scrolling)
    scrolledWindow.add_controller(scrollController);

    // Pan gesture: click+drag on scrolled window to scroll the view
    const panGesture = new Gtk.GestureDrag();
    panGesture.connect('drag-begin', (gesture, x, y) => {
        if (currentTool !== Tool.PAN) {
            gesture.set_state(Gtk.EventSequenceState.DENIED);
            return;
        }
        isPanning = true;
        panStartHVal = scrolledWindow.get_hadjustment().get_value();
        panStartVVal = scrolledWindow.get_vadjustment().get_value();
    });
    panGesture.connect('drag-update', (gesture, offsetX, offsetY) => {
        if (!isPanning) return;
        scrolledWindow.get_hadjustment().set_value(panStartHVal - offsetX);
        scrolledWindow.get_vadjustment().set_value(panStartVVal - offsetY);
    });
    panGesture.connect('drag-end', () => {
        isPanning = false;
    });
    // Pan gesture must have higher priority so it captures events before ScrolledWindow's kinetic scrolling
    panGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    scrolledWindow.add_controller(panGesture);

    mainBox.append(scrolledWindow);

    window.set_child(mainBox);

    // ── Keyboard shortcuts ──────────────────────────────────────────
    const keyController = new Gtk.EventControllerKey();
    keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_BackSpace) {
            if (selectedAnnotation !== null && selectedAnnotation >= 0 && selectedAnnotation < annotations.length) {
                annotations.splice(selectedAnnotation, 1);
                selectedAnnotation = null;
                canvas.queue_draw();
                return true;
            }
        }
        if (ctrl && keyval === Gdk.KEY_z) {
            if (annotations.length > 0) {
                annotations.pop();
                canvas.queue_draw();
            }
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_s) {
            const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
            if (shift) {
                saveToFile(window);
            } else {
                saveImage(window);
            }
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_c) {
            const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
            if (shift) {
                copyToClipboard(window);
                return true;
            }
        }
        if (ctrl && keyval === Gdk.KEY_o) {
            loadImageFile(window);
            return true;
        }
        if (ctrl && (keyval === Gdk.KEY_plus || keyval === Gdk.KEY_equal)) {
            applyZoom(zoomLevel + ZOOM_STEP);
            return true;
        }
        if (ctrl && (keyval === Gdk.KEY_minus || keyval === Gdk.KEY_underscore)) {
            applyZoom(zoomLevel - ZOOM_STEP);
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_0) {
            applyZoom(1.0);
            return true;
        }
        return false;
    });
    window.add_controller(keyController);

    window.present();
    showCaptureModeDialog(window);
});

app.run([]);
