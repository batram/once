# Nitter

Once used to ship a built-in Nitter collector, hardwired to nitter.net. That
instance shut down in September 2026, and the collector went with it. This
add-on brings the collector back and adds an X / Twitter redirect. It does not
depend on any single instance.

- **Sources.** Add `https://x.com/<user>` (or a twitter.com or nitter.net URL)
  as a source. The add-on fetches it from a healthy instance, using RSS where
  the instance offers it and the HTML timeline otherwise. Each post links to its
  canonical `https://x.com/<user>/status/<id>` address, so read state and
  bookmarks are kept when the add-on moves to another instance.
  `https://x.com/search?q=…` sources work too.
- **Redirect.** *X / Twitter → Nitter* sends x.com and twitter.com links to the
  current instance. It is listed under Settings › Redirects › From add-ons, where
  you can switch it off.
- **Picking an instance.** The list comes from
  [status.d420.de](https://status.d420.de/about). Only instances marked healthy
  and not flagged as bad are used. RSS-capable ones are preferred, then the
  highest-scoring, then the fastest.
  - That service checks every instance every 900 s and rate-limits clients that
    poll it often. The add-on keeps the list for an hour and never fetches it
    twice within 900 s, even after failures.
  - A copy of the list is kept in the add-on's synced storage, written at most
    once an hour, so a restart does not need to ask again.
- **Switching on failure.** When a feed fetch fails, or a page the redirect
  produced fails to load (network error, HTTP 5xx or 429), that instance is
  skipped for 30 minutes and the next healthy one is used. Open tabs on the
  failed instance move to the new one. A 404 means the account itself is
  missing, so it never triggers a switch.
- **Preferred instance.** You can pin one in the add-on's settings. It is used
  while it works, and the list takes over when it fails.

The `fetch:https://*/*` grant is broad on purpose. Instances come and go, and
the add-on has to be able to fetch whichever one the status page currently
lists.

Run `node scripts/validate-addon.js examples/addons/nitter` from the repository
root to check the package.
