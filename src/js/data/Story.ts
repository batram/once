import { OnceSettings } from "../OnceSettings"
import { URLRedirect } from "./URLRedirect"
import {
  CoreStory,
  SortableStory as CoreSortableStory,
  StoryTag,
  SubStory
} from "@once/core"

export { StoryTag, SubStory }

export interface SortableStory extends CoreSortableStory {
  el?: HTMLElement
}

export class Story extends CoreStory {
  matches_url(url: string): boolean {
    return this.matches_story_url(url) || this.matches_comment_url(url)
  }

  matches_story_url(url: string): boolean {
    const redirected_url = URLRedirect.redirect_url(this.href)
    return (
      this.href === url ||
      (redirected_url != this.href && redirected_url == url)
    )
  }

  async get_content(): Promise<string> {
    if (this._attachments && this._attachments.content) {
      let body = null
      if (this._attachments.content.data) {
        body = atob(this._attachments.content.data)
      } else {
        let provider = null
        if (OnceSettings.instance) {
          provider = OnceSettings.instance.once_db
        } else {
          provider = OnceSettings.remote
        }
        if (provider) {
          const attachment = await provider.getAttachment(this._id, "content")
          if (attachment) {
            body = new TextDecoder("utf-8").decode(attachment as Buffer)
          }
        }
      }

      if (body) {
        const title = document.createElement("title")
        title.innerText = this.title
        const content = title.outerHTML + body
        return content
      }
    }
  }
}
