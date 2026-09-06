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
Reimport to update a snapshot. With encrypted addon sync enabled, installed
snapshots reach your other devices automatically. For a linked development folder,
choose **Use this version on my devices** in its settings to share a snapshot.

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

Save tokens using the dedicated masked fields. Tokens are bound to the endpoint
you configured and never enter the addon script, ordinary synced options, or
conversation. [Encrypted addon sync](../../../docs/addon-sync-vault.md) includes
installed addons' tokens in the encrypted vault so you only unlock once on each
device. Otherwise tokens stay in the local secret store. Changing an endpoint
requires replacing its saved token. Electron and native mobile use protected local
storage; browser profiles offer remembering with weaker local protection.

The three prompt editors have separate Restore default buttons. Ordinary installed
addon options sync with Once; tokens require encrypted addon sync. Conversation
history stays in the current session. The app sends
article text and conversation context to the endpoint you choose. OpenAI requests
set `store: false`; this is not a promise about a provider's separate logging policy.

## Gemini API free-tier setup

Google's Gemini API works with the existing **compatible** provider through its
[Chat Completions endpoint](https://ai.google.dev/gemini-api/docs/openai).
No proxy, server deployment, or addon code change is required.

1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey), using a
   project whose Gemini API usage tier is **Free**. Keep that project on the free
   tier; enabling paid billing changes the applicable pricing. Prefer a newly
   created key; see Google's [current key requirements](https://ai.google.dev/gemini-api/docs/api-key).
2. In **Settings → Once Add-ons → What? Wait, who, why?**, enter:

   | Setting | Value |
   | --- | --- |
   | AI provider | `compatible` |
   | Model ID | `gemini-3.1-flash-lite` |
   | Chat Completions endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
   | Compatible API token | Your Gemini API key, saved in the masked field |
   | Enable web search | Off |

3. Set the endpoint before saving the key: Once binds the saved token to that
   exact endpoint. Keep the key out of the manifest and advanced JSON editor.
4. Open a story's addon tray to explain its title, then try **Summarize** and a
   follow-up question. These are separate requests. Reopening an existing tray
   reuses its answer during the same session.

For new projects, use `gemini-3.1-flash-lite`: Google has
[restricted 2.5 model access to previous users](https://discuss.ai.google.dev/t/gemini-2-5-flash-deprecated-without-warning-earlier-than-shutdown-date/174217/27).
A 404 with `gemini-2.5-flash-lite` can therefore mean the project lacks model
access even when the endpoint is correct. Change the model, keeping the endpoint
and saved key unchanged, then retry. The tray includes the provider's structured
error message when available to help distinguish model access from other failures.

Google lists 3.1 Flash-Lite's standard input and output as free on the free tier
([pricing](https://ai.google.dev/gemini-api/docs/pricing), checked 2026-09-06).
Availability and request/token quotas depend on the project and model; check
[active limits in AI Studio](https://ai.google.dev/gemini-api/docs/rate-limits).
HTTP 429 means a quota/rate limit was reached; wait for the relevant limit to reset
before retrying. The addon does not automatically switch to a paid provider.

The compatible connection does not enable native Google Search grounding. Leave
web search off for this setup; enabling it requires the separate SearXNG fallback.
Story text and follow-up context are sent to Google. Review the
[Gemini API terms](https://ai.google.dev/gemini-api/terms) for the data-use rules
that apply to your account and region before sending private content.

This setup uses the Gemini Developer API free tier. Vertex AI and Google Cloud
trial credits have separate endpoints, authentication, and billing rules.

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
