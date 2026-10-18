/**
 * Local revision ancestry only exists to relate replicas; application truth is
 * selected by the timestamped story-state merge policy.
 *
 * The limit is how far a replica may fall behind a document and still find a
 * common ancestor. Past it, the next revision arrives as a separate root: a
 * conflict whose resolution leaves a deleted leaf in every replica forever.
 * At 20, a device document publishing every 15 s lost ancestry after five
 * offline minutes (one desktop held 160 roots for one device). Revision ids
 * cost about 35 bytes each, kept only in the tree, so 100 stays small.
 */
export const LOCAL_POUCH_OPTIONS = {
  auto_compaction: true,
  revs_limit: 100
} as const
