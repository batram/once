# Roadmap

Detailed active implementation plans live in [`plans/`](plans/). Completed
plans are summarized in [HISTORY.md](HISTORY.md) and retained in Git history.

- [Future user theming](plans/design-system-theming-plan.md)
- [Firefox extensions and userscripts in the embedded browsers](plans/firefox-extensions-plan.md)
- [Once add-ons on every platform](plans/story-addons-plan.md)

## Near term

- **Testing**
  - Shared application tests with fake platform ports
  - Collector reload and CouchDB failure/retry coverage
  - Firefox and Chrome integration tests
  - Broader Electron unit and Playwright coverage
  - Portable, deterministic Electron E2E setup
  - Scheduled live collector compatibility monitoring with failure artifacts and notifications
- **Distribution**
  - Publish Firefox and Chrome extensions through official stores
  - Repeatable release validation, signing, and update workflows

## Next

- **Add-ons follow-ups** (the plan itself is complete; see
  [Add-ons](ADDONS.md))
  - Scripted add-ons on Firefox (a hosted sandbox page, or declarative only)
    and on Chrome (the manifest `sandbox` page)
  - Android emulator and iOS device runs of the mobile sandbox
  - A schema-driven configuration form for add-on collectors in the source
    editor
  - `ONCE_ADDONS` development directories for unpackaged Electron builds
  - A curated add-on index and scheduled update checks
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
  - Restore windows, tabs, navigation, recently closed tabs, and reading position
  - Signing, updates, and supported-platform packaging
  - Reader archive/cache fallback and a new secure video presenter (the
    unreachable legacy presenter and vendored runtime were removed)
- **Product**
  - Better sync setup, background behavior, and error reporting
  - Accounts and cross-device services with a clear privacy model
  - Saved content and search
  - Subscriptions and deduplication
  - Richer reading and media views
