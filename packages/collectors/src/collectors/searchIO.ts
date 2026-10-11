/**
 * What a collector gets to search with. The fetch is the shell's own, passed
 * in for the same reasons as `CommentsIO`'s: collectors cannot reach the
 * platform, and only the shell's fetch can carry the user's site session.
 */
export interface SearchIO {
  fetch: typeof globalThis.fetch
}
