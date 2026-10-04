package com.zmarn.once;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
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
 */
@CapacitorPlugin(name = "AddressBar")
public class AddressBarPlugin extends Plugin {
    private static final int PASTE_AND_GO = 0x0ACE5;
    private static final int CLEAR = 0x0ACE6;
    private volatile boolean editing;
    private volatile boolean hasText;

    @PluginMethod
    public void setEditing(PluginCall call) {
        hasText = call.getBoolean("hasText", false);
        editing = call.getBoolean("editing", false);
        call.resolve();
    }

    /** Adds the items to each text menu the shell WebView prepares. */
    ActionMode.Callback decorate(ActionMode.Callback inner) {
        return new ActionMode.Callback2() {
            @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
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
                return inner.onActionItemClicked(mode, item);
            }

            @Override public void onDestroyActionMode(ActionMode mode) {
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
        if (!editing) return false;
        MenuItem paste = menu.findItem(android.R.id.paste);
        int order = paste == null ? 0 : paste.getOrder();
        boolean added = false;
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
