# What? Wait, who, why?

A Once addon that explains a title, summarizes its article on request, and
answers follow-up questions in a tray below the story. It makes no AI requests
until you click its question-mark-and-sparkles button (or invoke its story action).

## Develop and configure

In Electron, open **Settings → Once Add-ons → Import addon… → Load directory…** and select this folder.
It works in packaged builds and remembers the folder; edits reload automatically.
Use **Unload** to remove the link without deleting the example files.

Alternatively, use **Import folder**, or ZIP this folder and choose **Import ZIP** on the import page.
Return to the Once Add-ons list and open **What? Wait, who, why?** for its connection,
search and prompt settings. The raw JSON editor is under **Advanced: edit addon JSON…**;
it is not needed for normal installation or setup.
Import keeps a snapshot on this device and shows the usual installation review.
The supplied manifest works directly: Once calculates the script hash for you.
Reimport to update a snapshot; import it separately on other devices that need it.

Set `ONCE_ADDONS` to this directory and launch an unpackaged Electron build using
the normal development workflow. It appears in Settings → Once Add-ons, including its
settings even though its manifest is not installed. Development options stay on
this device; packaged builds ignore `ONCE_ADDONS`. Its settings include local
Enable/Disable and Retry controls; disabling does not discard your configuration.

Run `node scripts/validate-addon.js examples/addons/what-wait-who-why` from the
repository root after building the shared packages. It validates the package and
prints the SHA-256 integrity of `main.js`. For URL installation, replace the
development-only `"script": "main.js"` with
`"script": { "url": "main.js", "integrity": "sha256-…" }`, using that exact hash,
then serve the directory and install its manifest URL. No service is deployed by
the example. Firefox additionally requires its usual hosted sandbox page.

Choose a provider, enter a model ID, and configure its full request endpoint:

| Provider | Default endpoint | Authentication |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/responses` | Bearer API token |
| Anthropic | `https://api.anthropic.com/v1/messages` | API key, optional workspace ID |
| Compatible | User supplied, including `/v1/chat/completions` | Optional bearer token |

Save tokens using the dedicated masked fields. Tokens stay in Once's device-local
secret store and are bound to the endpoint you configured. They never enter the
addon script, synced options, or conversation. Changing an endpoint requires
replacing its saved token. Electron and native mobile use their existing encrypted
stores; browser profiles use local browser storage, not equivalent OS encryption.

The three prompt editors have separate Restore default buttons. Ordinary installed
addon options sync with Once; tokens and conversation history do not. The app sends
article text and conversation context to the endpoint you choose. OpenAI requests
set `store: false`; this is not a promise about a provider's separate logging policy.

## Use

Opening a tray explains the title and answers it if it asks a question. For a
release announcement, the default prompt explains what the software does and who
uses it. Summarize is a separate action; the question box continues the conversation.
Saved/feed content is used before fetching and extracting the original article.
Reading content for the addon does not mark a story read or save an offline copy.

Close hides the tray; reopening reuses the answer. Row redraws and sorting preserve
the conversation. Clear conversation starts fresh; disabling the addon, changing
its options, restarting its sandbox, or restarting Once clears the session.
No conversations are persisted. Responses appear when complete; streaming is not
implemented. Stop prevents late answers; Retry repeats a failed request.

Web search is off by default. Enable it to use OpenAI or Anthropic's native search,
or configure a SearXNG `/search` endpoint for compatible models and native-search
unavailability. The SearXNG instance must allow `format=json`; many public instances
do not. Its token is optional. Fallback search sends one query, uses at most five
bounded snippets, and does not crawl result pages. Only referenced, supplied sources
become links. Summaries always use the article alone. Search failures offer Retry
and Answer without search; authentication errors and rate limits do not silently
switch providers.

## Limits and validation

Article input is capped at 64,000 characters, recent complete conversation pairs at
32,000, and each prompt at 16,000. The tray reports shortened context. Host requests
have a 120-second deadline, at most two concurrent tray invocations per addon, and
1 MiB request/response limits. Missing article text is labelled title-only and
cannot be summarized. Provider/model/tool errors are shown without crashing the addon.

Electron forwards cancellation through IPC. Native Capacitor HTTP currently has no
cancellation API: Stop revokes the invocation immediately, while the underlying
request may finish within its native timeout. Native responses are buffered before
the size check. Redirects are disabled explicitly on all connection transports.

The tests use this actual script with fixture providers and a local search fixture;
they require no real API key or paid requests. See `tests/unit/ui-web/ai-addon.test.js`
and the shared Electron, extension, and mobile addon tests for worked integrations.
To run just the native addon fixture, set `ONCE_MOBILE_ADDONS_ONLY=1` before
`npm run test:mobile:e2e:android:local` (or the iOS suite on a supported Mac).
