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

export interface StoryAttachment {
  [index: string]: {
    content_type: string
    data?: string
    raw_content?: string
    digest?: string
    length?: number
  }
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
