export interface StoryTag {
  class: string
  text: string
  href?: string
  icon?: string
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

export interface SortableStory {
  read_state: "unread" | "read" | "skipped"
  timestamp: number | string | Date
}
