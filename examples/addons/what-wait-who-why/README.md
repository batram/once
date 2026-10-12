# What? Wait, who, why? (What4)

What4 explains a story's title, summarizes its article and answers follow-up
questions in a tray. Opening the tray starts explanation and summary requests;
turning on web search adds a cited web section. Requests stream when the platform
transport supports streaming. Closing or stopping the invocation cancels it.

## Setup

1. Open **Settings → AI & Search** and add an AI connection. Supported protocols
   are OpenAI Responses, Anthropic Messages and compatible Chat Completions.
2. Save the endpoint and API token together. Compatible local servers can omit a
   token. Tokens are bound to their saved endpoint; changing that destination
   requires replacing the token before it can be used there.
3. Open **Default model** and choose a connection and model. Discovery offers
   provider model IDs; a manual ID is also supported.
4. Open **Settings → Once Add-ons → What4**. Its model row initially inherits the
   global default. Choose **Use another model** only when What4 should override it.

AI & Search lists registered consumers as links to their own settings. What4 no
longer keeps provider adapters, AI credentials or search credentials in its package.
Its own settings retain prompts, web-search enablement and YouTube behavior.

## Search and article sources

Native provider search is preferred where supported. When native search is
unavailable, What4 uses the default SearXNG or Tavily connection configured in
**AI & Search → Search**. Search is opt-in and can incur provider charges. Summaries
remain article-only. Search failure offers retry or an answer without search where
that choice is meaningful. A provider authentication failure is not a reason to
silently switch services.

Article context comes from saved content, a fetched article, or the live open page.
YouTube stories can use captions through the addon's declared YouTube connection.
When Once cannot read an article, the UI identifies title-only answers. Anthropic
models can optionally fetch the page through their native tool; unsupported tools
produce a structured fallback, without claiming that missing content was read.

## Credentials and sync

Configure credentials centrally. **Settings → Sync → Encrypted sync** has one
passphrase, one recovery key and one lock state. Add-ons and AI & Search have
separate switches on each device. Disabling either switch keeps a local copy before
leaving that dataset; it does not disable the other one or affect other devices.
Pairing can carry the same shared sync passphrase.

Existing What4 provider/search settings migrate before the verified package update.
The migration fingerprints and verifies the source and preserves endpoint bindings,
custom model selection and existing central defaults. Encrypted credentials remain
encrypted. If an earlier experimental separate AI vault exists, its data is kept
until it can be imported into shared sync.

Addon code never receives stored tokens. Provider requests omit cookies, refuse
redirects, redact credentials, and have bounded input/output and request deadlines.
Opening a tray sends its article context to the selected provider. OpenAI requests
set `store: false`; the provider's own logging and retention policies still apply.

## Conversations and prompts

Prompts for explanations, summaries, web context and follow-up answers remain
editable in What4 settings. Answers preserve citations returned by the shared
service. The addon keeps recent complete exchanges in memory with bounded article
and history context. Conversations are not persisted by What4. Settings changes,
Clear, or disposing the addon reset its in-memory conversation.

## Development

Run `node scripts/validate-addon.js examples/addons/what-wait-who-why` from the
repository root. The build derives the bundled script integrity from the package's
actual bytes. The public addon contract and capability rules are in
[ADDONS.md](../../../docs/ADDONS.md).

What4 declares `ai` and `search` capabilities. It uses `context.ai.resolve()`,
`context.ai.generate()` and `context.querySearch()`, so cancellation belongs to the
tray invocation. Provider-specific request formats and SSE parsing live in the app.
