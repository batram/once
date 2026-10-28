/** How long a granted download may take to start: a redirect or two, not a page's later whim. */
const GRANT_MS = 5000

/**
 * Downloads the user asked for, by URL: a trusted click on a link to one, or
 * the shell navigating to one. A download that starts for a granted URL may
 * prompt (an extension install); one a page starts by itself finds no grant.
 * Each grant is spent by the first download that takes it and fades on its own.
 */
export class DownloadGrants {
  private readonly grants = new Map<string, number>()

  constructor(private readonly now = () => Date.now()) {}

  grant(url: string): void {
    this.grants.set(url, this.now() + GRANT_MS)
  }

  /** Spends the grant for the URL; false when there is none or it has faded. */
  take(url: string): boolean {
    const until = this.grants.get(url)
    if (until === undefined) return false
    this.grants.delete(url)
    return this.now() < until
  }
}
