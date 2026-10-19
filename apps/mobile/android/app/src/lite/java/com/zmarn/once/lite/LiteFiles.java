package com.zmarn.once.lite;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Files for the broker: the synchronous `onceLiteFiles` JavascriptInterface
 * (`read`, `unzip`), the JSON stores and the package directories it asks for
 * over the channel. Directories are `asset:<path>` (APK assets, the bundled
 * extensions), `@bundle` (the built `lite-*.js` under assets/public), or a
 * path under the storage root, never anywhere else.
 */
public final class LiteFiles {
    public static final String BUNDLE_DIRECTORY = "@bundle";
    static final String ASSET_PREFIX = "asset:";
    private static final Set<String> TEXT_TYPES = new HashSet<>(Arrays.asList("js", "mjs", "css", "json", "html", "htm", "txt", "xml", "svg", "map"));
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{1,80}");
    private static final long ARCHIVE_LIMIT = 33L * 1024 * 1024;

    private final Context context;
    final File storageRoot;
    private final ExecutorService io = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-files");
        thread.setDaemon(true);
        return thread;
    });

    LiteFiles(Context context) {
        this.context = context.getApplicationContext();
        storageRoot = new File(this.context.getFilesDir(), "lite-extensions");
        //noinspection ResultOfMethodCallIgnored
        storageRoot.mkdirs();
        clearStaging();
    }

    /** Staging directories of unfinished installs from an earlier process. */
    private void clearStaging() {
        io.execute(() -> delete(new File(new File(storageRoot, "packages"), ".staging")));
    }

    void close() { io.shutdownNow(); }

    void register(BrokerChannel channel) {
        channel.onRequest("store.read", (params, reply) -> io.execute(() -> {
            try {
                File file = new File(resolveDirectory(params.getString("directory")), fileName(params.getString("name")));
                reply.resolve(new JSONObject().put("json", file.isFile() ? new String(readAll(file), StandardCharsets.UTF_8) : JSONObject.NULL));
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("store.write", (params, reply) -> io.execute(() -> {
            try {
                File directory = resolveDirectory(params.getString("directory"));
                //noinspection ResultOfMethodCallIgnored
                directory.mkdirs();
                File file = new File(directory, fileName(params.getString("name")));
                File temp = new File(directory, file.getName() + ".tmp");
                try (FileOutputStream out = new FileOutputStream(temp)) { out.write(params.getString("json").getBytes(StandardCharsets.UTF_8)); }
                if (!temp.renameTo(file)) throw new IOException("Could not replace " + file.getName());
                reply.resolve(null);
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("files.mkdir", (params, reply) -> io.execute(() -> {
            try {
                File target = resolve(params.getString("directory"), params.getString("path"));
                if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Could not create " + params.getString("path"));
                reply.resolve(null);
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("files.write", (params, reply) -> io.execute(() -> {
            try {
                File target = resolve(params.getString("directory"), params.getString("path"));
                if (target.exists()) throw new IOException(params.getString("path") + " already exists");
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Could not create " + parent.getName());
                try (FileOutputStream out = new FileOutputStream(target)) { out.write(Base64.decode(params.getString("base64"), Base64.DEFAULT)); }
                reply.resolve(null);
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("files.remove", (params, reply) -> io.execute(() -> {
            try { delete(resolveDirectory(params.getString("directory"))); reply.resolve(null); }
            catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("files.list", (params, reply) -> io.execute(() -> {
            try {
                String[] names = resolveDirectory(params.getString("directory")).list();
                JSONArray entries = new JSONArray();
                if (names != null) for (String name : names) if (!name.startsWith(".")) entries.put(name);
                reply.resolve(new JSONObject().put("entries", entries));
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
        channel.onRequest("package.readArchive", (params, reply) -> io.execute(() -> {
            try (InputStream in = context.getContentResolver().openInputStream(Uri.parse(params.getString("file")))) {
                if (in == null) throw new IOException("The file could not be opened");
                reply.resolve(new JSONObject().put("base64", Base64.encodeToString(readAll(in, ARCHIVE_LIMIT), Base64.NO_WRAP)));
            } catch (Exception error) { reply.reject(error.getMessage()); }
        }));
    }

    /**
     * `onceLiteFiles.read`: a JSON `{"text"}` or `{"base64"}` document, or the
     * JSON text `null` when missing (a Java null would reach the page as
     * `undefined`). Any thread.
     */
    @JavascriptInterface
    public String read(String directory, String path) {
        try {
            byte[] bytes = bytes(directory, path);
            if (bytes == null) return "null";
            String extension = path.lastIndexOf('.') < 0 ? "" : path.substring(path.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT);
            JSONObject document = new JSONObject();
            if (TEXT_TYPES.contains(extension)) document.put("text", new String(bytes, StandardCharsets.UTF_8));
            else document.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            return document.toString();
        } catch (Exception error) { return "null"; }
    }

    /**
     * `onceLiteFiles.unzip`: unpacks the archive into the staging directory
     * named by the token, refusing entries that would leave it, and answers
     * the entry list; the broker reads each entry back with {@link #read}.
     */
    @JavascriptInterface
    public String unzip(String token, String archiveBase64) {
        try {
            if (token == null || !TOKEN.matcher(token).matches()) throw new IOException("Invalid staging token");
            File staging = new File(new File(new File(storageRoot, "packages"), ".staging"), token);
            if (!staging.isDirectory() && !staging.mkdirs()) throw new IOException("Could not create the staging directory");
            JSONArray entries = new JSONArray();
            long total = 0;
            try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(Base64.decode(archiveBase64, Base64.DEFAULT)))) {
                for (ZipEntry entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                    String name = entry.getName();
                    File target = child(staging, name.endsWith("/") ? name.substring(0, name.length() - 1) : name);
                    long size = 0;
                    if (entry.isDirectory()) {
                        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Could not create " + name);
                    } else {
                        File parent = target.getParentFile();
                        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Could not create " + name);
                        try (FileOutputStream out = new FileOutputStream(target)) {
                            byte[] buffer = new byte[16384];
                            for (int read; (read = zip.read(buffer)) != -1; ) {
                                total += read;
                                if (total > ARCHIVE_LIMIT) throw new IOException("The archive is too large");
                                out.write(buffer, 0, read);
                                size += read;
                            }
                        }
                    }
                    entries.put(new JSONObject().put("name", name).put("isDirectory", entry.isDirectory()).put("size", size));
                }
            }
            return new JSONObject().put("entries", entries).toString();
        } catch (Exception error) {
            try { return new JSONObject().put("error", error.getMessage() == null ? error.toString() : error.getMessage()).toString(); }
            catch (Exception ignored) { return "{\"error\":\"unzip failed\"}"; }
        }
    }

    /** The built web asset (`public/<name>`), or null. */
    byte[] asset(String path) {
        try (InputStream in = context.getAssets().open(path, AssetManager.ACCESS_STREAMING)) { return readAll(in, Long.MAX_VALUE); }
        catch (IOException error) { return null; }
    }

    byte[] bytes(String directory, String path) throws IOException {
        String relative = normalize(path);
        if (relative == null) return null;
        if (BUNDLE_DIRECTORY.equals(directory)) return relative.contains("/") ? null : asset("public/" + relative);
        if (directory.startsWith(ASSET_PREFIX)) return asset(directory.substring(ASSET_PREFIX.length()) + "/" + relative);
        File file = child(resolveDirectory(directory), relative);
        return file.isFile() ? readAll(file) : null;
    }

    /** True when the bundled extension's manifest ships in the APK. */
    boolean assetExists(String directory, String path) {
        return directory.startsWith(ASSET_PREFIX) && asset(directory.substring(ASSET_PREFIX.length()) + "/" + path) != null;
    }

    private File resolve(String directory, String path) throws IOException {
        String relative = normalize(path);
        if (relative == null) throw new IOException("Invalid path " + path);
        return child(resolveDirectory(directory), relative);
    }

    /** A storage directory: under the root, named by the broker with the root's own prefix. */
    File resolveDirectory(String directory) throws IOException {
        if (directory == null || directory.startsWith(ASSET_PREFIX) || BUNDLE_DIRECTORY.equals(directory)) throw new IOException("Not a storage directory");
        File file = new File(directory).getCanonicalFile();
        String root = storageRoot.getCanonicalPath();
        if (!file.getPath().equals(root) && !file.getPath().startsWith(root + File.separator)) throw new IOException("Directory outside the extension storage");
        return file;
    }

    private static File child(File directory, String relative) throws IOException {
        File file = new File(directory, relative);
        String canonical = file.getCanonicalPath();
        String base = directory.getCanonicalPath();
        if (!canonical.equals(base) && !canonical.startsWith(base + File.separator)) throw new IOException("Path leaves its directory");
        return file;
    }

    /** Extension-relative, `/`-joined, no `.`/`..` segments; null when it cannot be. */
    static String normalize(String path) {
        if (path == null) return null;
        List<String> parts = new ArrayList<>();
        for (String part : path.replace('\\', '/').split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) return null;
            parts.add(part);
        }
        return parts.isEmpty() ? null : String.join("/", parts);
    }

    private static String fileName(String name) throws IOException {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.startsWith(".")) throw new IOException("Invalid store name");
        return name;
    }

    static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    public static byte[] readAll(File file) throws IOException {
        try (InputStream in = new java.io.FileInputStream(file)) { return readAll(in, Long.MAX_VALUE); }
    }

    static byte[] readAll(InputStream in, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        long total = 0;
        for (int read; (read = in.read(buffer)) != -1; ) {
            total += read;
            if (total > limit) throw new IOException("The file is too large");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
