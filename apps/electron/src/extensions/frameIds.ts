import { WebFrameMain, webFrameMain } from "electron"

interface FrameIds {
  frameId: number
  parentFrameId: number
}

const MAIN_FRAME: FrameIds = { frameId: 0, parentFrameId: -1 }

export function frameIdsOf(frame: WebFrameMain | null | undefined): FrameIds {
  try {
    if (!frame || frame.parent === null) return MAIN_FRAME
    return {
      frameId: frame.frameTreeNodeId,
      parentFrameId: frame.parent.parent === null ? 0 : frame.parent.frameTreeNodeId
    }
  } catch {
    return MAIN_FRAME
  }
}

export function frameIds(isMainFrame: boolean, processId: number, routingId: number): FrameIds {
  if (isMainFrame) return MAIN_FRAME
  try {
    return frameIdsOf(webFrameMain.fromId(processId, routingId))
  } catch {
    return MAIN_FRAME
  }
}
