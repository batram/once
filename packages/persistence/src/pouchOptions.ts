/**
 * Local revision ancestry only exists to relate replicas; application truth is
 * selected by the timestamped story-state merge policy.
 */
export const LOCAL_POUCH_OPTIONS = {
  auto_compaction: true,
  revs_limit: 20
} as const
