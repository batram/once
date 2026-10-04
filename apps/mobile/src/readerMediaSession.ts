import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import type { ReaderMediaAction, ReaderTtsEngine, ReaderTtsHostController } from "./readerTtsHostBridge"

/**
 * iOS speaks through the media session plugin, on the app's own audio
 * session, so lock screen controls can pause speech natively; elsewhere the
 * text-to-speech plugin already plays where system controls reach it.
 */
export function nativeReaderSpeechEngine(): ReaderTtsEngine | undefined {
  return Capacitor.getPlatform() === "ios"
    ? registerPlugin<ReaderTtsEngine>("ReaderMediaSession")
    : undefined
}

export interface ReaderMediaSessionPlugin {
  update(options: {
    title: string
    subtitle: string
    playing: boolean
    paused: boolean
    index: number
    count: number
  }): Promise<void>
  clear(): Promise<void>
  addListener(
    event: "command",
    listener: (event: { action: ReaderMediaAction }) => void
  ): Promise<PluginListenerHandle>
}

/**
 * Mirrors the speaking reader into the system media controls (notification,
 * lock screen, headset buttons) and routes their commands back to that
 * reader, which keeps speaking even when its tab is not selected.
 */
export function installReaderMediaSession(
  tts: ReaderTtsHostController,
  describe: (frame: Window) => { title: string; subtitle: string },
  plugin: ReaderMediaSessionPlugin | null = Capacitor.isNativePlatform()
    ? registerPlugin<ReaderMediaSessionPlugin>("ReaderMediaSession")
    : null
): void {
  if (!plugin) return
  let shown = false
  tts.onSpeech((frame, state) => {
    if (!frame || !state) {
      if (shown) void plugin.clear().catch(() => undefined)
      shown = false
      return
    }
    shown = true
    const { title, subtitle } = describe(frame)
    void plugin.update({
      title,
      subtitle,
      playing: state.playing,
      paused: state.paused,
      index: state.segment,
      count: state.segments ?? 0
    }).catch(() => undefined)
  })
  void plugin.addListener("command", (event) => tts.command(event.action))
    .catch(() => undefined)
}
