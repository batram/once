export interface AddonStatus {
  state: string
  error?: string
}

const statuses = new Map<string, AddonStatus>()
const listeners = new Set<() => void>()
let retry: ((id: string) => void) | undefined

export function setAddonStatus(id: string, state: string, error?: string): void {
  statuses.set(id, { state, error })
  for (const listener of listeners) listener()
}

export function getAddonStatus(id: string): AddonStatus | undefined { return statuses.get(id) }
export function onAddonStatus(listener: () => void): void { listeners.add(listener) }
export function setAddonRetry(handler: (id: string) => void): void { retry = handler }
export function retryAddon(id: string): void { retry?.(id) }
