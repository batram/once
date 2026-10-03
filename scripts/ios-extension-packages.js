// Upstream release artifacts; compatibility changes are applied to a separate copy.
module.exports = [
  {
    id: "addon@darkreader.org", directory: "darkreader", name: "Dark Reader", version: "4.9.133",
    url: "https://github.com/darkreader/darkreader/releases/download/v4.9.133/darkreader-chrome-mv3.zip",
    sha256: "a5a1a9c78d377fafd8c9190ce9d57b96f89bc95d21f077888601e4c445b20ebf",
    background: "event-page", source: "https://github.com/darkreader/darkreader/tree/v4.9.133"
  },
  {
    id: "sponsorBlocker@ajay.app", directory: "sponsorblock", name: "SponsorBlock", version: "6.1.7",
    url: "https://addons.mozilla.org/firefox/downloads/file/4897574/sponsorblock-6.1.7.xpi",
    sha256: "0d50e1632c6f15ee15a543e670e1c572974605a5c02622916e08e026803df83f",
    source: "https://github.com/ajayyy/SponsorBlock/tree/6.1.7"
  },
  {
    id: "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", directory: "violentmonkey", name: "Violentmonkey", version: "2.49.0",
    url: "https://github.com/violentmonkey/violentmonkey/releases/download/v2.49.0/Violentmonkey-webext-v2.49.0.zip",
    sha256: "847c86a20e214d3515a9dfabe5357875af20e305bbcc1692d6e109a4edd6a7f3",
    background: "violentmonkey-event-page", source: "https://github.com/violentmonkey/violentmonkey/tree/v2.49.0",
    compatibility: "Experimental: basic userscripts and GM storage. Notifications, browser downloads, request-header overrides and background scheduling are not supported. Cloud sync is not yet validated."
  }
]
