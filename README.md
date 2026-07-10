# ![icon](https://user-images.githubusercontent.com/1382274/184474910-e0b46b64-8254-4604-a176-1679255c65bb.png?small) Once browser side-panel extension

## About

[Once](https://github.com/batram/) retooled as a side-panel extension for Firefox and Chrome.
Collect stories from different sources (RSS, Hacker News, Lobsters or Reddit), so you can stop scrolling through those sites all day and look at each story once.

## Features

- Collect and merge stories from different sources
- Mark stories as read or skip them
- Search local stories and online on the different sources
- Sync state via couchdb
- Filter stories based on keywords
- Dark and Light theme
- _TODO_ Extract and present just the content (text, images, video)

## Build

```
npm install
npm run build:extensions
npm run start:electron
npm run test:electron
npm run make:electron
```

Load the unpacked extension from `apps/firefox-extension/dist` in Firefox or
`apps/chrome-extension/dist` in Chrome. See `DEVELOPMENT.md` for development,
validation, and packaging commands.

## Screenshots
<img width="1266" height="880" alt="image" src="https://github.com/user-attachments/assets/3a0ff606-ce39-4a9c-a002-1eedfa9873df" />
