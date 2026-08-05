# Future plan: user theming

Status: proposed; implementation has not started.

This work is intentionally outside the completed design-system refactor. The refactor
establishes the token and cascade contracts that make theming possible; it does not ship a
user-theme product.

The current implementation reserves `layer(user)` and tests that public tokens can override
application defaults. No settings surface writes that layer. Reader and presenter documents
remain outside the shared token contract unless this future project explicitly brings them in.

## Goal

Provide user theming with an explicit public surface, recovery path, and security/privacy
model. CSS cascade layers organize trusted styles; they are not a sandbox. Arbitrary CSS can
close an injected wrapper, create unlayered rules, use `!important`, hide recovery UI, and
request remote resources permitted by CSP.

The product must expose two clearly different contracts:

- **Tier 1: supported token themes.** A versioned set of custom properties, validated before
  storage. Color themes are safe by construction; density values use documented ranges.
- **Tier 2: advanced custom CSS.** This may break on update, obscure the UI, and make network
  requests through permitted CSS URLs. It must either be parsed and restricted or be labelled
  explicitly as unrestricted. A cascade layer must never be described as containment.

## Work

### 1. Decide scope

Explicitly choose and document which surfaces are themed:

- shell;
- reader document;
- outline presenter;
- other presenter iframes;
- Electron browser/error surfaces.

Each included separate document needs its own token stylesheet and application/injection
path. Excluded surfaces must be stated as product limitations.

### 2. Define the public token and selector API

Document:

- supported color tokens;
- supported density/type tokens and accepted ranges;
- stable `data-part` selectors;
- versioning/deprecation policy;
- unsupported internal class names.

Add `data-part` only where a real public styling use case exists. First-party skins should
exercise the same public surface.

### 3. Extend settings and persistence deliberately

Add typed APIs for theme mode and custom theme data across:

- core settings types;
- `OnceClient`;
- settings persistence;
- settings-change events;
- platform theme adapters;
- UI restore/save/subscription behavior.

Do not cast `"custom"` to the existing `ThemeName` union.

Decide whether custom theme data syncs through Pouch. Keep the emergency disable flag local
to each installation so a broken synced skin cannot disable recovery everywhere.

The settings UI requires explicit loading, ready, validation-error, save-error, reset, and
preview states.

### 4. Tier 1 supported themes

Store a structured token map, not a CSS string. Validate that:

- the token name is public;
- color syntax is allowed;
- numeric values fall within documented ranges;
- URL-bearing values are rejected;
- unknown tokens are preserved or rejected according to a documented forward-compatibility
  policy.

Render the validated map into `layer(user)`. Add tests proving overrides work on same-element
defaults and across platform layers. Ship two or three first-party themes, including at least
one density variation.

### 5. Tier 2 advanced CSS

Choose one model.

**Restricted CSS**

- Parse with a real CSS parser.
- Reject `@import`, external `url()`, `@font-face`, unapproved at-rules, and disallowed
  selectors/properties.
- Reconstruct the accepted AST inside `layer(user)`.
- Reject malformed input rather than interpolating it.

**Unrestricted CSS**

- State that layers are organizational, not containment.
- Warn that CSS can hide UI, break layout, and request remote resources permitted by CSP.
- Do not claim privacy isolation.
- Retain a local, out-of-band recovery mechanism.

Do not interpolate an arbitrary string into `@layer user { ${css} }` and describe it as
unable to escape.

### 6. Recovery

Provide all of:

- live preview that is not persisted until explicit save;
- automatic rollback of an unconfirmed preview;
- a local “disable custom theme on next start” flag;
- a keyboard recovery chord handled independently of styled controls;
- a startup query/flag or platform menu recovery path where practical;
- last-known-good theme data.

“Reached interactive” is not sufficient health detection: a skin can leave the app running
while hiding the settings entry point.

## Exit criteria

- Typed settings path with no unsafe theme cast.
- Tier 1 themes validated, synced according to the chosen policy, and tested.
- Tier 2 security/privacy behavior accurately documented and tested.
- A hostile theme cannot permanently lock out recovery.
- Every in-scope document receives the intended theme.
- First-party themes use only public tokens and `data-part` hooks.

## Owner decisions

1. Which surfaces are in the theming contract: shell, reader, presenters, and Electron
   auxiliary surfaces.
2. Whether Tier 2 CSS is restricted through parsing or intentionally unrestricted.
3. Whether custom theme data syncs; the recovery-disable flag should remain local.
4. Allowed density ranges for Tier 1 tokens.

## Verification and release gates

Add stable scripts rather than requiring contributors to remember raw commands. At minimum,
the shared, Electron, mobile-web, and applicable native gates must remain green. Native
Android/iOS visual and interaction gates are required for changes to safe-area, touch,
keyboard, or native WebView behavior. Web/unit checks do not count as native release delivery.

Because `npm run check` can replace the mobile `--e2e` bundle, theme test scripts must rebuild
or verify their expected bundle stamp before running.
