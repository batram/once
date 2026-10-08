package com.zmarn.once;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Paste and go" and "Clear" for the web address field. Its text menu belongs
 * to the shell WebView, so the items are added only while the field has focus.
 * The address editor also reads and writes the clipboard and shares the page
 * address through it, which the shell WebView cannot do on its own.
 */
@CapacitorPlugin(name = "AddressBar")
public class AddressBarPlugin extends Plugin {
    private static final int PASTE_AND_GO = 0x0ACE5;
    private static final int CLEAR = 0x0ACE6;
    private static final int EXPLODE = 0x0ACE7;
    private volatile boolean editing;
    private volatile boolean hasText;
    private volatile boolean explodable;
    /** The text menu on screen, refreshed when the selection becomes explodable. */
    private ActionMode shown;

    @PluginMethod
    public void setEditing(PluginCall call) {
        hasText = call.getBoolean("hasText", false);
        editing = call.getBoolean("editing", false);
        boolean wasExplodable = explodable;
        explodable = editing && call.getBoolean("explodable", false);
        if (wasExplodable != explodable) {
            getActivity().runOnUiThread(() -> { if (shown != null) shown.invalidate(); });
        }
        call.resolve();
    }

    /** Whether "Paste and go" has anything to open, without reading the clip. */
    @PluginMethod
    public void clipboardState(PluginCall call) {
        call.resolve(new JSObject().put("hasText", clipboardHasText()));
    }

    /** The clipboard's text for the address editor's "Paste and go" row. */
    @PluginMethod
    public void readClipboard(PluginCall call) {
        call.resolve(new JSObject().put("text", clipboardText()));
    }

    @PluginMethod
    public void copyText(PluginCall call) {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            call.reject("No clipboard");
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText(call.getString("label", "Link"), call.getString("text", "")));
        call.resolve();
    }

    /** The system share sheet for a page address. */
    @PluginMethod
    public void share(PluginCall call) {
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, call.getString("url", ""));
        String title = call.getString("title", "");
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        Intent chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().runOnUiThread(() -> {
            getContext().startActivity(chooser);
            call.resolve();
        });
    }

    /** Adds the items to each text menu the shell WebView prepares. */
    ActionMode.Callback decorate(ActionMode.Callback inner) {
        return new ActionMode.Callback2() {
            @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                shown = mode;
                return inner.onCreateActionMode(mode, menu);
            }

            @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                boolean changed = inner.onPrepareActionMode(mode, menu);
                return addItems(menu) || changed;
            }

            @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                if (item.getItemId() == PASTE_AND_GO) {
                    String text = clipboardText();
                    mode.finish();
                    if (!text.isEmpty()) notifyListeners("pasteAndGo", new JSObject().put("text", text));
                    return true;
                }
                if (item.getItemId() == CLEAR) {
                    mode.finish();
                    notifyListeners("clear", new JSObject());
                    return true;
                }
                if (item.getItemId() == EXPLODE) {
                    mode.finish();
                    notifyListeners("explode", new JSObject());
                    return true;
                }
                return inner.onActionItemClicked(mode, item);
            }

            @Override public void onDestroyActionMode(ActionMode mode) {
                if (shown == mode) shown = null;
                inner.onDestroyActionMode(mode);
            }

            @Override public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                if (inner instanceof ActionMode.Callback2) ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
                else super.onGetContentRect(mode, view, outRect);
            }
        };
    }

    /** Places the items right after Paste; true when the menu changed. */
    private boolean addItems(Menu menu) {
        menu.removeItem(PASTE_AND_GO);
        menu.removeItem(CLEAR);
        menu.removeItem(EXPLODE);
        if (!editing) return false;
        MenuItem paste = menu.findItem(android.R.id.paste);
        int order = paste == null ? 0 : paste.getOrder();
        boolean added = false;
        if (explodable) {
            // First, so it stays on the bar rather than in the overflow.
            menu.add(Menu.NONE, EXPLODE, Menu.FIRST, "Explode").setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
            added = true;
        }
        if (clipboardHasText()) {
            menu.add(Menu.NONE, PASTE_AND_GO, order, "Paste and go").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
            added = true;
        }
        if (hasText) {
            menu.add(Menu.NONE, CLEAR, order, "Clear").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
            added = true;
        }
        return added;
    }

    /** Reads only the description: reading the clip itself shows the paste notice. */
    private boolean clipboardHasText() {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipDescription description = clipboard == null ? null : clipboard.getPrimaryClipDescription();
        return description != null && (description.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN)
            || description.hasMimeType(ClipDescription.MIMETYPE_TEXT_HTML)
            || description.hasMimeType(ClipDescription.MIMETYPE_TEXT_URILIST));
    }

    private String clipboardText() {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence text = clip.getItemAt(0).coerceToText(getContext());
        return text == null ? "" : text.toString().trim();
    }
}
