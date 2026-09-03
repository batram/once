import { Story } from "@once/core"
import { registerStoryElement } from "../story/storyElements"
import * as outline from "./outline"

export declare interface PresenterOptions {
  story_button: {
    value: "always" | "handled" | "never"
    description: string
  }
  [key: string]: { value: boolean | string; description: string }
}

export declare interface Presenter {
  presenter_options: PresenterOptions
  story_elem_button?: (story: Story, intab: boolean) => HTMLElement
  handle_url(url: string): boolean
}

/**
 * The built-in presenters, registered as story elements beside whatever
 * add-ons contribute. The reader's outline button is the only one; it is the
 * worked example of a row button that is not part of the row itself.
 */
const builtins: { id: string; presenter: Presenter }[] = [
  {
    id: "builtin/outline",
    presenter: {
      presenter_options: outline.presenter_options,
      story_elem_button: outline.story_elem_button,
      handle_url: outline.handle_url
    }
  }
]

for (const { id, presenter } of builtins) {
  registerStoryElement({
    id,
    slot: "button",
    render: (row) => {
      const button = presenter.story_elem_button
      if (!button) return null
      const mode = presenter.presenter_options.story_button.value
      if (mode === "always" || (mode === "handled" && presenter.handle_url(row.story.href))) {
        return button(row.story, false)
      }
      return null
    }
  })
}
