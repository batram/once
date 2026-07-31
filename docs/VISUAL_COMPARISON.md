# Built-app visual comparison

`npm run visual:compare` builds and launches the real packaged Electron app and
generated mobile web app, loads deterministic fixture data, and captures a
side-by-side visual review. It does not render a separate component gallery.

The default run covers both light and dark themes for:

- the populated story list and mixed read/bookmarked states;
- left and right story swipes held at intermediate stages;
- the Settings index and every Settings section;
- Settings search results, structured Sources, source/group forms, filter
  editing and validation, Filters/Redirects text modes, the redirect editor,
  and expanded Swipe advanced controls;
- a real, expanded source-load failure in the Error Log; and
- the populated Reader.

Each screenshot has a matching computed-style JSON file for automated or agent
analysis.

## Run it

From the repository root:

```bash
npm run visual:compare
```

The command builds both targets, moves the previous `current` artifacts to
`baseline`, captures a new `current` run, and writes:

```text
artifacts/app-visual-review/
  index.html
  current/
  baseline/
  runs/<full-git-sha>/
```

Open `artifacts/app-visual-review/index.html` in a browser. Press Left Arrow to
put the current build on the left, or Right Arrow to put the previous/baseline
build on the left. Links below each image open its computed-style JSON.

The artifact directory is intentionally ignored by Git.

## Compare with a Git revision

Capture and retain an old revision without touching the current run:

```bash
npm run visual:compare -- --ref 7f17cce --ref-only
```

The tool resolves the ref to a full commit SHA, creates an isolated detached
temporary worktree, installs and builds that revision, and stores its results
under `runs/<full-git-sha>`. Other retained revisions are not removed.

Then compare the current build with that stored run:

```bash
npm run visual:compare -- --ref 7f17cce
```

A complete stored run is reused. Run `--ref-only` again when fixture behavior,
the screenshot matrix, or the JSON schema changes and the retained revision
needs to be recaptured.

Each build discovers its own rendered Settings destinations. The report uses
the union of the current and comparison artifact sets, so a newly added section
shows `No previous run` and a removed section shows `Not present in the current
build` instead of preventing the comparison.

Historical builds use their own lockfile and may report old deprecations or
audit findings. Installation policy changes needed by an old lockfile are
applied only inside its temporary worktree; the active checkout and machine
configuration are not changed.

## Options

```text
--skip-build      reuse existing Electron and mobile build outputs
--electron-only   capture only the packaged Electron app
--mobile-only     capture only the generated mobile web app
--ref REF         compare with REF and retain results by full commit SHA
--ref-only        refresh and retain REF without capturing the current tree
--output DIR      write the report and artifacts below a different directory
```

Use `--skip-build` only when the existing app outputs are known to match the
source being reviewed. Fixture and report code still run from the active
checkout.

## Deterministic data and error coverage

Both targets load one JSON source and one RSS source containing the same varied
story set. The matrix exercises normal, read, bookmarked, redirected, filtered,
and mid-swipe states.

Immediately before each Error Log screenshot, the harness adds
`/failure.rss`. The fixture server returns HTTP 503 through the normal source
loading path, so the application creates a real error entry and action
controls. The harness expands the entry and normalizes only volatile timestamp,
port, and generated stack-location text. It then clears the error and restores
the two valid sources so unrelated screenshots remain normal states.

## Computed-style JSON

Style companions use schema version 2 and contain:

- viewport, theme, active panel, and document metadata;
- stable paths, element signatures, relevant attributes, and rectangles;
- selected computed layout, typography, color, interaction, and native-control
  properties;
- `::before` and `::after` computed styles;
- curated records for repeated story and Reader surfaces; and
- `structuralCoverage`, a hybrid collection of visible UI elements.

The structural collector always keeps uniquely identified visible controls,
limits repeated non-ID signatures to 12, and limits a screenshot to 500
structural elements. Story-item and rendered Reader subtrees are excluded from
that broad pass because the curated selectors already sample them. Non-visual
tags and hidden elements are omitted.

`structuralCoverage.omitted` reports counts for excluded subtrees, non-visual
tags, hidden elements, repeat limiting, and the global element cap. Check these
counts before concluding that an element is absent from the rendered app.

## Adding coverage

Keep fixture states deterministic and exercise the application through its
real UI or runtime path. Avoid inserting final visual markup directly into the
DOM. Normalize only values that are intrinsically volatile and irrelevant to
the visual contract.

When adding or removing a screenshot state:

1. update `buildImageNames()` and the relevant capture matrix in
   `scripts/visual-compare.js`;
2. update `tests/unit/visual-compare.test.js`;
3. run the focused tests and a live capture; and
4. refresh any historical run used for comparison.
