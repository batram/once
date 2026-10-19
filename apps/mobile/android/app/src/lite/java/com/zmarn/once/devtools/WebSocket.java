package com.zmarn.once.devtools;

import android.net.LocalSocket;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.function.Consumer;

/**
 * The little of RFC 6455 a DevTools connection needs: the HTTP upgrade, masked
 * text frames out, fragmented text frames in, pings answered, close honoured.
 * No TLS, no extensions: the peer is Chromium in this process, over a Unix socket.
 */
final class WebSocket {
    private static final int TEXT = 0x1, BINARY = 0x2, CONTINUATION = 0x0, CLOSE = 0x8, PING = 0x9, PONG = 0xA;
    private final LocalSocket socket;
    private final DataInputStream in;
    private final OutputStream out;
    private final SecureRandom random = new SecureRandom();
    private volatile boolean closed;

    private WebSocket(LocalSocket socket) throws IOException {
        this.socket = socket;
        in = new DataInputStream(socket.getInputStream());
        out = socket.getOutputStream();
    }

    /** Performs the client handshake for {@code path} on a connected socket. */
    static WebSocket upgrade(LocalSocket socket, String path) throws IOException {
        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        String key = android.util.Base64.encodeToString(nonce, android.util.Base64.NO_WRAP);
        OutputStream out = socket.getOutputStream();
        out.write(("GET " + path + " HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = readLine(socket.getInputStream());
        if (!status.startsWith("HTTP/1.1 101")) throw new IOException("WebSocket upgrade refused: " + status);
        while (!readLine(socket.getInputStream()).isEmpty()) { /* headers; the accept key is Chromium's own */ }
        // Frames may take as long as the page takes to answer; only the handshake is bounded.
        socket.setSoTimeout(0);
        return new WebSocket(socket);
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') line.write(c);
        }
        return line.toString("US-ASCII");
    }

    /** Sends one masked text frame. Callers serialise writes. */
    void sendText(String text) throws IOException {
        send(TEXT, text.getBytes(StandardCharsets.UTF_8));
    }

    private synchronized void send(int opcode, byte[] payload) throws IOException {
        if (closed) throw new IOException("WebSocket closed");
        ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
        frame.write(0x80 | opcode);
        int length = payload.length;
        if (length < 126) frame.write(0x80 | length);
        else if (length < 65536) { frame.write(0x80 | 126); frame.write(length >>> 8); frame.write(length); }
        else {
            frame.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) (((long) length >>> shift) & 0xFF));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        frame.write(mask);
        byte[] masked = new byte[length];
        for (int index = 0; index < length; index++) masked[index] = (byte) (payload[index] ^ mask[index & 3]);
        frame.write(masked);
        out.write(frame.toByteArray());
        out.flush();
    }

    /** Reads frames until the socket closes, handing complete text messages to {@code messages}. */
    void read(Consumer<String> messages) throws IOException {
        ByteArrayOutputStream fragments = null;
        while (!closed) {
            int first;
            try { first = in.readUnsignedByte(); } catch (EOFException end) { return; }
            int second = in.readUnsignedByte();
            boolean fin = (first & 0x80) != 0;
            int opcode = first & 0x0F;
            boolean masked = (second & 0x80) != 0;
            long length = second & 0x7F;
            if (length == 126) length = in.readUnsignedShort();
            else if (length == 127) length = in.readLong();
            if (length < 0 || length > Integer.MAX_VALUE - 16) throw new IOException("WebSocket frame too large");
            byte[] mask = masked ? new byte[4] : null;
            if (masked) in.readFully(mask);
            byte[] payload = new byte[(int) length];
            in.readFully(payload);
            if (masked) for (int index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
            switch (opcode) {
                case TEXT:
                case BINARY:
                    if (fin) messages.accept(new String(payload, StandardCharsets.UTF_8));
                    else { fragments = new ByteArrayOutputStream(); fragments.write(payload); }
                    break;
                case CONTINUATION:
                    if (fragments == null) throw new IOException("WebSocket continuation without a start");
                    fragments.write(payload);
                    if (fin) { messages.accept(fragments.toString("UTF-8")); fragments = null; }
                    break;
                case PING:
                    synchronized (this) { send(PONG, payload); }
                    break;
                case CLOSE:
                    close();
                    return;
                default: break;
            }
        }
    }

    void close() {
        if (closed) return;
        closed = true;
        try { synchronized (this) { send(CLOSE, new byte[0]); } } catch (IOException ignored) { /* already gone */ }
        try { socket.close(); } catch (IOException ignored) { /* already gone */ }
    }
}
