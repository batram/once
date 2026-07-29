# ![icon](https://user-images.githubusercontent.com/1382274/184474910-e0b46b64-8254-4604-a176-1679255c65bb.png?small) Once

Collect stories from different sources (RSS, Hacker News, Lobsters or Reddit, custom), so you can stop scrolling through those sites all day and look at each story once.
Available as desktop app for Electron, side-panel extensions for Firefox and Chrome,
and Capacitor applications for Android and iOS.

## Downloads

[Latest releases](https://github.com/batram/once/releases/latest) include:
 - Windows Electron App
 - Firefox extension
 - Chrome extension

## Features

- Collect and merge stories from different sources
- Mark stories as read or skip them
- Search local stories and online on the different sources
- Sync state via couchdb
- Filter stories based on keywords
- Dark and Light theme
- Reader mode

## Quick start

```bash
npm install
npm run check
```

`npm run check` type-checks the workspace, validates package boundaries, and
creates development builds for both browser extensions.

## Run and build

```bash
# Browser extensions
npm run build:extensions

# Electron desktop app
npm run start:electron
npm run test:electron
npm run make:electron

# Capacitor mobile apps
npm run run:mobile:android
npm run run:mobile:ios
npm run test:mobile
```

Browser build outputs are written below `apps/firefox-extension/dist` and
`apps/chrome-extension/dist`, separated into `dev` and `release` directories.
Load the relevant channel directory as a temporary Firefox add-on or an
unpacked Chrome extension.

## Documentation

- [Development](docs/DEVELOPMENT.md): installation, local workflows, testing, and
  packaging
- [Architecture](docs/ARCHITECTURE.md): platform design, package structure, and
  boundaries
- [Code map](docs/CODEMAP.md): composition roots, feature ownership, generated
  code, and where to start common changes
- [Collectors](docs/COLLECTORS.md): source loading, built-in collectors, and
  Geny Match selector configuration
- [Releasing](docs/RELEASING.md): versioning, cutting a tagged release, and CI
  publishing
- [Roadmap](docs/ROADMAP.md)

## Screenshots

<img width="1266" height="880" alt="image" src="https://github.com/user-attachments/assets/3a0ff606-ce39-4a9c-a002-1eedfa9873df" />
