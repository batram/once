import { Story, URLRedirect } from "@once/core"

export class StoryWorkingSet {
  private readonly stories = new Map<string, Story>()
  private readonly comments = new Map<string, string>()

  constructor(
    private readonly onChanged: (
      href: string,
      story: Story,
      previous: Story | undefined
    ) => void,
    private readonly onAdded: (story: Story) => void,
    private readonly onRemoved: (href: string) => void
  ) {}

  set(href: string, story: Story, quiet = false): Story {
    Story.assertIngestible(story)
    if (href !== story.href) {
      throw new Error("Story map key does not match its URL")
    }
    const previous = this.stories.get(href)
    this.stories.set(href, story)
    URLRedirect.redirect_url(story.href)
    if (story.comment_url) this.comments.set(story.comment_url, story.href)
    story.substories.forEach((substory) => {
      if (substory.comment_url) {
        this.comments.set(substory.comment_url, story.href)
      }
    })
    if (!quiet) this.onChanged(href, story, previous)
    return story
  }

  add(story: Story): void {
    this.set(story.href, story, true)
    this.onAdded(story)
  }

  remove(href: string): void {
    const removed = this.stories.delete(href)
    for (const [url, storyHref] of this.comments) {
      if (storyHref === href) this.comments.delete(url)
    }
    if (removed) this.onRemoved(href)
  }

  get(href: string): Story | undefined {
    return this.stories.get(href)
  }

  lookup(url: string): Story | null {
    const story = this.stories.get(url)
    if (story) return story
    const commentHref = this.comments.get(url)
    return commentHref ? this.stories.get(commentHref) ?? null : null
  }

  values(): IterableIterator<Story> {
    return this.stories.values()
  }

  snapshot(): Story[] {
    return Array.from(this.stories.values())
  }

  hrefs(): string[] {
    return Array.from(this.stories.keys())
  }
}
