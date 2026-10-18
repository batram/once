import { registerPlugin } from "@capacitor/core"

/** Binary keys are hex (byte-order preserving); values are base64. */
export interface NativeLevelBridge {
  execute(options: Record<string, unknown>): Promise<Record<string, unknown>>
}

export const NativeLevel = registerPlugin<NativeLevelBridge>("NativeDatabase")
