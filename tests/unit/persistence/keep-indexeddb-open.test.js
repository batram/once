const test = require("node:test")
const assert = require("node:assert/strict")

test("an aborted transaction does not reach the database's onabort", () => {
  class FakeDatabase extends EventTarget {
    transaction() {
      const txn = new EventTarget()
      // Stand-in for IndexedDB's bubbling: transaction events continue to the database.
      txn.abort = () => {
        const event = new Event("abort", { bubbles: true })
        txn.dispatchEvent(event)
        if (!event.cancelBubble) this.dispatchEvent(new Event("abort"))
      }
      return txn
    }
  }
  globalThis.IDBDatabase = FakeDatabase
  try {
    const { keepIndexedDbOpenAfterAborts } = require("../../../packages/persistence/dist")
    keepIndexedDbOpenAfterAborts()
    const db = new FakeDatabase()
    let databaseAborts = 0
    let transactionAborts = 0
    db.addEventListener("abort", () => databaseAborts++)
    const txn = db.transaction(["docs"], "readwrite")
    txn.addEventListener("abort", () => transactionAborts++)
    txn.abort()
    assert.equal(transactionAborts, 1)
    assert.equal(databaseAborts, 0)
  } finally {
    delete globalThis.IDBDatabase
  }
})
