export interface ImageTextPoint { x: number; y: number }
export interface ImageTextWord {
  text: string
  topLeft: ImageTextPoint
  topRight: ImageTextPoint
  bottomLeft: ImageTextPoint
}
export interface ImageTextResult { lines: ImageTextWord[][]; textLines: string[]; lineBounds: { x: number; y: number; width: number; height: number }[] }
