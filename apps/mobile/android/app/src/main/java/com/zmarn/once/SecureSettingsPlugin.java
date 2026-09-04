package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureSettings")
public class SecureSettingsPlugin extends Plugin {
    private static final String KEY_ALIAS = "once.sync.settings";
    private static final String PREFS = "once_secure_settings";
    private static final String SYNC_URL = "sync_url";
    private static final String SECRET_PREFIX = "secret.";
    private static final int GCM_TAG_BITS = 128;

    @PluginMethod
    public void getSyncUrl(PluginCall call) {
        try {
            String encrypted = preferences().getString(SYNC_URL, null);
            JSObject result = new JSObject();
            result.put("value", encrypted == null ? "" : decrypt(encrypted));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to read secure sync settings", error);
        }
    }

    @PluginMethod
    public void setSyncUrl(PluginCall call) {
        String value = call.getString("value", "");
        try {
            SharedPreferences.Editor edit = preferences().edit();
            if (value.isEmpty()) edit.remove(SYNC_URL);
            else edit.putString(SYNC_URL, encrypt(value));
            if (!edit.commit()) throw new IllegalStateException("Secure settings commit failed");
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to save secure sync settings", error);
        }
    }

    @PluginMethod
    public void getSecret(PluginCall call) {
        String key = call.getString("key", "");
        if (key.isEmpty()) {
            call.reject("A secret needs a key");
            return;
        }
        try {
            String encrypted = preferences().getString(SECRET_PREFIX + key, null);
            JSObject result = new JSObject();
            result.put("value", encrypted == null ? "" : decrypt(encrypted));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to read secure setting", error);
        }
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        if (key.isEmpty()) {
            call.reject("A secret needs a key");
            return;
        }
        try {
            SharedPreferences.Editor edit = preferences().edit();
            if (value.isEmpty()) edit.remove(SECRET_PREFIX + key);
            else edit.putString(SECRET_PREFIX + key, encrypt(value));
            if (!edit.commit()) throw new IllegalStateException("Secure settings commit failed");
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to save secure setting", error);
        }
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        );
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String data = Base64.encodeToString(
            cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
            Base64.NO_WRAP
        );
        return iv + "." + data;
    }

    private String decrypt(String value) throws Exception {
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid secure setting");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        return new String(
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        );
    }
}
