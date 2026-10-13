export const IMAGE_TEXT_IPC = {
  command: "once:image-text:command",
  reply: "once:image-text:reply",
  closed: "once:image-text:closed",
  /** A double-clicked image, from the frame preload: `{ src, x, y }` in that frame's viewport. */
  request: "once:image-text:request"
}
