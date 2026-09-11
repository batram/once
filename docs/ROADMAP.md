# Roadmap

Detailed active implementation plans live in [`plans/`](plans/). Completed
plans are summarized in [HISTORY.md](HISTORY.md) and retained in Git history.

- [Future user theming](plans/design-system-theming-plan.md)
- [Extension reliability](plans/extension-reliability-plan.md)
- [Android GeckoView extension management](plans/android-gecko-extension-management.md)

Completed and kept for reference: [Firefox extensions and userscripts in the
embedded browsers](plans/firefox-extensions-plan.md) and [Once add-ons on every
platform](plans/story-addons-plan.md).

## Near term

- **Testing**
  - CouchDB failure and retry coverage for sync (collector reload, the fake
    platform ports, the browser and Electron suites and the portable Electron
    e2e setup all exist now)
  - Scheduled live collector compatibility monitoring with failure artifacts and notifications
- **Distribution**
  - Publish Firefox and Chrome extensions through official stores
  - Repeatable release validation, signing, and update workflows

## Next

- **Add-ons follow-ups** (the plan itself is complete; see
  [Add-ons](ADDONS.md))
  - Mozilla distribution policy review and a future Firefox build option
    that omits add-ons. The working Firefox build uses a packaged MV2 sandbox
    with no hosting setup; signing and store distribution remain separate work.
  - A curated add-on index and automatic update checks (a manual check
    exists for URL installs)
- **Mobile deeper integration**
  - Native and share-driven source creation
  - Background refresh and notifications
  - Universal/deep links and incoming share intents
  - Richer native navigation, accessibility, and physical-device coverage
  - Store signing and automated TestFlight/Google Play internal delivery
- **Website**
  - Product landing page with links to available apps
  - Full Once web application using `@once/platform-web`
  - Hosting, persistence, sync, testing, and security design

## Later

- **Electron**
  - Restore windows, open tabs and reading position (recently closed tabs
    already survive a restart)
  - Signing and supported-platform packaging (Squirrel updates and a manual
    release check exist)
  - A new secure video presenter (the unreachable legacy presenter and
    vendored runtime were removed)
- **Product**
  - Better sync setup, background behavior, and error reporting
  - Accounts and cross-device services with a clear privacy model
  - Search over saved content; removing saved copies and saving images
    (stored articles themselves landed, see [Architecture](ARCHITECTURE.md))
  - Subscriptions and deduplication
  - Richer reading and media views
