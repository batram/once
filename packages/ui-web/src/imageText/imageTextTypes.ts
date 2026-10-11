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
