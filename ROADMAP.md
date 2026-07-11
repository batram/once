# Roadmap

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

- **Mobile app**
  - Choose the runtime and packaging toolchain
  - Implement mobile adapters using the shared packages
  - Add navigation, offline storage, sync, and tests
- **Website**
  - Product landing page with links to available apps
  - Full Once web application using `@once/platform-web`
  - Hosting, persistence, sync, testing, and security design

## Later

- **Electron**
  - Restore windows, tabs, navigation, recently closed tabs, and reading position
  - Signing, updates, and supported-platform packaging
  - Reader archive/cache fallback and secure video presenter
- **Product**
  - Better sync setup, background behavior, and error reporting
  - Accounts and cross-device services with a clear privacy model
  - Saved content and search
  - Subscriptions and deduplication
  - Richer reading and media views
