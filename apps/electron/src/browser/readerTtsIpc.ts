/** The reader's speech settings and turn-taking, relayed through main (ReaderTtsRelay.ts). */
export const READER_TTS_IPC = {
  /** Reader → main, invoke: the remembered voice and speeds. */
  get: "once:reader-tts:get",
  /** Reader → main, send: the settings as the reader last changed them. */
  set: "once:reader-tts:set",
  /** Reader → main, send: this reader starts reading aloud. */
  claim: "once:reader-tts:claim",
  /** Reader → main, send: this reader stopped on its own. */
  release: "once:reader-tts:release",
  /** Main → reader: another reader took over; stop. */
  stop: "once:reader-tts:stop"
}
