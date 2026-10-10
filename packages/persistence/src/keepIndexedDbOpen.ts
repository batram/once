let installed = false

/**
 * PouchDB's IndexedDB adapter closes its connection for good when any
 * transaction aborts (the abort bubbles to the database's onabort), and every
 * later call then fails with "The database connection is closing" until the
 * app restarts. iOS aborts in-flight writes when it suspends the app, which is
 * exactly when tab sync and the reading tabs flush. Stopping the abort at the
 * transaction fails only that operation; the connection stays usable.
 */
export function keepIndexedDbOpenAfterAborts(): void {
  if (installed || typeof IDBDatabase === "undefined") return
  installed = true
  const transaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    const txn = transaction.apply(this, args)
    txn.addEventListener("abort", (event) => event.stopPropagation())
    return txn
  } as IDBDatabase["transaction"]
}
