export interface StoryTag {
  class: string
  text: string
  href?: string
  icon?: string
}

export interface SubStory {
  type: string
  comment_url: string
  timestamp: string | number | Date
  tags?: StoryTag[]
}

/**
 * PouchDB attachments on a stored story. A loaded story carries stubs
 * (`digest`, `length`, `stub`); `raw_content` is the transient carrier for
 * html that has not been written yet, which the store turns into the
 * attachment on save and never keeps in memory afterwards.
 */
export interface StoryAttachment {
  [index: string]: {
    content_type: string
    raw_content?: string
    digest?: string
    length?: number
    stub?: boolean
    revpos?: number
  }
}

/** What the `content` attachment is and where it came from. */
export interface StoredContentMeta {
  /** A feed included the text, or the page was fetched and extracted. */
  source: "feed" | "page"
  saved_at: number
  title?: string
  byline?: string
  site_name?: string
}

export interface FilterableStory {
  href: string
  title: string
  filter?: string
  tags?: StoryTag[]
  substories?: {
    tags?: StoryTag[]
  }[]
}

export interface SortableStory<TElement = unknown> {
  read_state: "unread" | "read" | "skipped"
  timestamp: number | string | Date
  el?: TElement
}
