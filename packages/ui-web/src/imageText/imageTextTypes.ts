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
 * CSS pixels, and the picture's natural size that recognized words refer to;
 * `pageTop` and `pageBottom` are the page viewport's edges, where a sweep
 * autoscrolls the page, in the view's coordinates.
 */
export interface ImageTextViewLayout {
  left: number; top: number; width: number; height: number; naturalWidth: number; naturalHeight: number
  pageTop: number; pageBottom: number
  /** The view's own place in the page's viewport. */
  viewLeft: number; viewTop: number
}

/** The app to an overlay view (Electron's anchored frame, Android's system WebView). */
export type ImageTextViewMessage =
  | { type: "layout"; layout: ImageTextViewLayout }
  /** Where the view loads the picture recognition read, for the reading flourish's brightness. */
  | { type: "image"; url: string }
  | { type: "result"; result: ImageTextResult | null; message?: string }
  /** For Electron's bar, which its host in the page holds (see imageTextAnchor.ts). */
  | { type: "status"; text: string }

/** An overlay view to the app. */
export type ImageTextViewEvent =
  | { type: "close" }
  /** The view's page has loaded and listens for messages. */
  | { type: "ready" }
  | { type: "scroll"; deltaY: number }
  /** The recognized words' boxes as fractions of the drawn picture. */
  | { type: "words"; boxes: { left: number; top: number; right: number; bottom: number }[] }
  | { type: "sweeping"; sweeping: boolean }
  | { type: "status"; text: string }

export interface ImageTextViewBridge {
  send(event: ImageTextViewEvent): void
  onMessage(handler: (message: ImageTextViewMessage) => void): void
}
