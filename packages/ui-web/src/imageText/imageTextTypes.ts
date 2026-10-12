export interface ImageTextPoint { x: number; y: number }
export interface ImageTextWord {
  text: string
  topLeft: ImageTextPoint
  topRight: ImageTextPoint
  bottomLeft: ImageTextPoint
}
export interface ImageTextResult { lines: ImageTextWord[][]; textLines: string[]; lineBounds: { x: number; y: number; width: number; height: number }[] }

/** Where an image's content is drawn this frame. */
export interface ImageTextFit {
  /** The content box in viewport pixels, and the part of it its scrolling ancestors leave visible. */
  left: number
  top: number
  width: number
  height: number
  clipPath: string
  visibleBox: { left: number; top: number; right: number; bottom: number }
  visible: boolean
  /** The drawn image (after object-fit) relative to the content box. */
  imageLeft: number
  imageTop: number
  imageWidth: number
  imageHeight: number
}

/**
 * Where the drawn picture sits inside an app-owned overlay view, in the view's
 * CSS pixels, and the picture's natural size that recognized words refer to.
 */
export interface ImageTextViewLayout { left: number; top: number; width: number; height: number; naturalWidth: number; naturalHeight: number }

/** The app to an overlay view (Electron's out-of-page overlay). */
export type ImageTextViewMessage =
  | { type: "layout"; layout: ImageTextViewLayout }
  | { type: "image"; bytes: Uint8Array }
  | { type: "result"; result: ImageTextResult | null; message?: string }
  | { type: "status"; text: string }
  | { type: "sweeping"; sweeping: boolean }

/** An overlay view to the app. */
export type ImageTextViewEvent =
  | { type: "close" }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "sweeping"; sweeping: boolean }
  | { type: "status"; text: string }
  | { type: "size"; width: number; height: number }

export interface ImageTextViewBridge {
  send(event: ImageTextViewEvent): void
  onMessage(handler: (message: ImageTextViewMessage) => void): void
}
