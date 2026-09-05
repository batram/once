/** @param {import('@once/core').OnceAddonApi} once */
export default function activate(once) {
  once.onBadges((_contribution, stories) =>
    stories.map(story => `${story.title.length} ${once.settings.suffix}`))
  once.onInvoke((action, story) => {
    if (action === "copy-title") once.copyText(story, story.title)
  })
}
