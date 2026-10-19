package com.zmarn.once;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.text.TextUtils;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;

/** The engine hit-tests a long-press but draws no menu; this is Once's menu for it. */
final class LinkContextMenu {
    private LinkContextMenu() {}

    /** What was pressed: a link, media, or both. Each field may be null. */
    static final class Target {
        /** Media kinds, numbered as GeckoView's ContextElement types. */
        static final int TYPE_NONE = 0, TYPE_IMAGE = 1, TYPE_VIDEO = 2, TYPE_AUDIO = 3;
        final String link;
        final String linkText;
        final String media;
        final int mediaType;
        final String referrer;
        /** In the browsing page itself, where its text can be selected; not the shell's Reader frame. */
        final boolean inPage;

        Target(String link, String linkText, String media, int mediaType, String referrer, boolean inPage) {
            this.link = link;
            this.linkText = linkText;
            this.media = media;
            this.mediaType = mediaType;
            this.referrer = referrer;
            this.inPage = inPage;
        }
    }

    /** One of the shell's own items for the link, such as an add-on's page action. */
    static final class Item {
        final String id;
        final String label;
        Item(String id, String label) { this.id = id; this.label = label; }

        /** The shell's items as sent over the bridge; entries without an id or label are dropped. */
        static List<Item> list(org.json.JSONArray array) {
            List<Item> items = new ArrayList<>();
            if (array == null) return items;
            for (int index = 0; index < array.length(); index++) {
                org.json.JSONObject item = array.optJSONObject(index);
                if (item == null || item.optString("id").isEmpty() || item.optString("label").isEmpty()) continue;
                items.add(new Item(item.optString("id"), item.optString("label")));
            }
            return items;
        }
    }

    /** The shell item id of "Select text in image"; the shell runs the overlay and recognition. */
    static final String IMAGE_TEXT = "once:image-text";
    /** The same, out of the page in the app's own view (prototype, offered beside it for comparison). */
    static final String IMAGE_TEXT_OVERLAY = "once:image-text-overlay";
    /**
     * Offers IMAGE_TEXT_OVERLAY. Off: it lags the page by a frame, delays taps
     * (breaking double-tap selection) and misplaces under pinch zoom, where
     * the in-page layer moves with the page. See ImageTextOverlay.
     */
    static final boolean IMAGE_TEXT_OVERLAY_ENABLED = false;

    static void show(Activity activity, ImageFetcher runtime, Target target,
                     BiConsumer<String, Boolean> openInTab) {
        show(activity, runtime, target, java.util.Collections.emptyList(), openInTab, null);
    }

    /**
     * openInTab receives the URL and whether the new tab stays in the
     * background; runItem the id of a chosen shell item, or is null where no
     * shell handles items (then shell-run entries such as IMAGE_TEXT are left out).
     */
    static void show(Activity activity, ImageFetcher runtime, Target target, List<Item> items,
                     BiConsumer<String, Boolean> openInTab, java.util.function.Consumer<String> runItem) {
        String link = target.link;
        String media = target.media;
        if (link == null && media == null) return;

        List<String> labels = new ArrayList<>();
        List<Runnable> actions = new ArrayList<>();
        if (link != null) {
            if (isWebUrl(link)) {
                labels.add("Open in new tab");
                actions.add(() -> openInTab.accept(link, false));
                labels.add("Open in background tab");
                actions.add(() -> openInTab.accept(link, true));
            }
            labels.add("Copy link address");
            actions.add(() -> copy(activity, "Link", link));
            if (!TextUtils.isEmpty(target.linkText)) {
                labels.add("Copy link text");
                actions.add(() -> copy(activity, "Link text", target.linkText.trim()));
            }
            labels.add("Share link");
            actions.add(() -> share(activity, link));
            for (Item item : items) {
                labels.add(item.label);
                actions.add(() -> runItem.accept(item.id));
            }
        }
        if (media != null) {
            String noun = mediaNoun(target.mediaType);
            if (isWebUrl(media)) {
                labels.add("Open " + noun + " in new tab");
                actions.add(() -> openInTab.accept(media, false));
            }
            if (target.mediaType == Target.TYPE_IMAGE) {
                // Android has no Live Text; on-device OCR selects the image's text in place.
                if (runItem != null && target.inPage && (isWebUrl(media) || media.startsWith("data:image/"))) {
                    labels.add("Select text in image");
                    actions.add(() -> runItem.accept(IMAGE_TEXT));
                    if (IMAGE_TEXT_OVERLAY_ENABLED) {
                        labels.add("Select text in image (overlay)");
                        actions.add(() -> runItem.accept(IMAGE_TEXT_OVERLAY));
                    }
                }
                labels.add("Copy image");
                actions.add(() -> ImageShare.copy(activity, runtime, media, target.referrer));
                labels.add("Share image");
                actions.add(() -> ImageShare.share(activity, runtime, media, target.referrer));
                if (ImageShare.canSave()) {
                    labels.add("Save image");
                    actions.add(() -> ImageShare.save(activity, runtime, media, target.referrer));
                }
            }
            labels.add("Copy " + noun + " address");
            actions.add(() -> copy(activity, noun, media));
            labels.add("Share " + noun + " link");
            actions.add(() -> share(activity, media));
        }

        TextView title = new TextView(activity);
        title.setText(link != null ? link : media);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        title.setTextAppearance(android.R.style.TextAppearance_Material_Subhead);
        int padding = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        title.setPadding(padding, padding, padding, padding / 2);

        new AlertDialog.Builder(activity)
            .setCustomTitle(title)
            .setItems(labels.toArray(new String[0]), (dialog, which) -> actions.get(which).run())
            .show();
    }

    private static boolean isWebUrl(String url) {
        return url.startsWith("https://") || url.startsWith("http://");
    }

    private static String mediaNoun(int type) {
        if (type == Target.TYPE_VIDEO) return "video";
        if (type == Target.TYPE_AUDIO) return "audio";
        return "image";
    }

    private static void copy(Context context, String label, String value) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        // Android 13+ confirms clipboard writes itself.
        if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
    }

    private static void share(Activity activity, String url) {
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, url);
        activity.startActivity(Intent.createChooser(send, null));
    }
}
