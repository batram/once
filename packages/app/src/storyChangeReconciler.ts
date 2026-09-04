// Reconciling a story document that changed under the app: one written by
// another tab of this device (observed), or one that replication pulled in
// (remote). Both merge through the timestamped sync policy and leave the
// working set holding whatever the database now agrees on.

import { Story } from "@once/core"
import { mergeStorySyncState, sameStorySyncState } from "./storySyncPolicy"
import { StoryWorkingSet } from "./StoryWorkingSet"
import { DatabaseChange, StoryStorePort } from "./types"

export class StoryChangeReconciler {
  constructor(
    private readonly workingSet: StoryWorkingSet,
    private readonly storyStore: StoryStorePort
  ) {}

  async observed(change: DatabaseChange): Promise<void> {
    if (change.doc?._deleted) {
      this.workingSet.remove(change.id.substring("sto_".length))
      return
    }
    if (!change.doc) return

    const changedStory = Story.from_obj(change.doc)
    const currentStory = this.workingSet.get(changedStory.href)
    if (!currentStory) return

    const storedStory = await this.storyStore.getStory(changedStory.href)
    if (!storedStory) {
      this.workingSet.remove(changedStory.href)
      return
    }

    const reconciled = mergeStorySyncState(storedStory, currentStory)
    let effectiveStory = storedStory
    if (!sameStorySyncState(reconciled, storedStory)) {
      effectiveStory = await this.storyStore.saveStory(reconciled)
    }
    if (
      currentStory._rev !== effectiveStory._rev ||
      !sameStorySyncState(currentStory, effectiveStory)
    ) {
      this.workingSet.set(effectiveStory.href, effectiveStory)
    }
  }

  async remote(change: DatabaseChange): Promise<void> {
    if (!change.id.startsWith("sto_") || !change.doc) return

    if (change.doc._deleted) {
      this.workingSet.remove(change.id.substring("sto_".length))
      return
    }

    const remoteStory = Story.from_obj(change.doc)
    const currentStory = this.workingSet.get(remoteStory.href)
    const localStory = await this.storyStore.getStory(remoteStory.href)
    const mergeBase = localStory ?? currentStory ?? remoteStory
    // Timestamped offline edits win by time. Untimestamped feed defaults use
    // the legacy rank and therefore cannot replace an established read,
    // skipped, starred, or filtered state.
    const merged = mergeStorySyncState(mergeBase, remoteStory)
    let effectiveStory = localStory ?? remoteStory

    if (!sameStorySyncState(merged, effectiveStory)) {
      effectiveStory = await this.storyStore.saveStory(merged)
    }

    if (currentStory) {
      if (
        currentStory._rev !== effectiveStory._rev ||
        !sameStorySyncState(currentStory, effectiveStory)
      ) {
        this.workingSet.set(effectiveStory.href, effectiveStory)
      }
      return
    }

    if (change.presentation !== "background") {
      this.workingSet.add(effectiveStory)
    }
  }
}
