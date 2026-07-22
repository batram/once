# Releasing

Once ships three published products from a single tag: the **Electron** desktop
app (Windows), and the **Firefox** and **Chrome** side-panel extensions. The
Capacitor mobile apps share the same version number but are not built or
published by the release workflow.

Releases are cut by pushing a `vX.Y.Z` tag. GitHub Actions
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) then
rebuilds every product from that tag, signs the Firefox XPI with Mozilla, and
publishes a GitHub release with all artifacts attached.

## Versioning

The root [`package.json`](../package.json) `version` is the single source of
truth. The `version` npm lifecycle hook runs
[`scripts/sync-release-version.js`](../scripts/sync-release-version.js), which
fans that version out to:

- `apps/electron`, `apps/chrome-extension`, `apps/firefox-extension`,
  `apps/mobile` — each `package.json` and its `package-lock.json` entry
- the iOS `MARKETING_VERSION` in
  `apps/mobile/ios/App/App.xcodeproj/project.pbxproj`

Never hand-edit the per-product versions; bump the root and let the hook sync.

## Cutting a release

Work from a clean, green `main`.

1. **Bump the version** (this runs the sync hook; it does not commit or tag):

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. **Write the release notes** at `.github/release-notes/vX.Y.Z.md`. Put the
   human-readable summary on top, then a `## Product status` block near the
   bottom. That block is machine-checked and **must** contain one line per
   published product, marked `Changed` or `Unchanged` (em dash, optional
   description):

   ```markdown
   - Electron: Changed — short description
   - Chrome: Changed — short description
   - Firefox: Unchanged
   ```

3. **Verify** the version/notes contract locally:

   ```bash
   npm run verify:release-version -- vX.Y.Z
   ```

4. **Commit and tag.** Match the existing history: a `vX.Y.Z` commit message and
   a lightweight tag.

   ```bash
   git add -A
   git commit -m "vX.Y.Z"
   git tag vX.Y.Z
   ```

5. **Push** the branch and the tag. Pushing the tag is what triggers the release
   build and the public GitHub release:

   ```bash
   git push origin main vX.Y.Z
   ```

To re-run a release for a tag that already exists, use the workflow's
`workflow_dispatch` trigger with the tag name instead of pushing a new tag.

## What CI checks and produces

The workflow runs three jobs:

- **Browser extensions** (Ubuntu) — `npm ci`, verify version, run the extension
  test suite, package the Chrome ZIP, and sign the Firefox XPI with Mozilla via
  `web-ext sign`. Requires the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository
  secrets.
- **Electron for Windows** — `npm ci`, verify version, run Electron unit/e2e
  tests, and `make:electron` (Squirrel installer, NuGet package, ZIP).
- **Publish GitHub release** — downloads both sets of artifacts, verifies them,
  and runs `gh release create` with the notes file as the release body.

Two scripts enforce the contract:

- [`verify-release-version.js`](../scripts/verify-release-version.js) — the tag
  must equal `v` + the root version, the notes file must exist, the three
  published product versions must match the root, and the notes must mark each
  product `Changed`/`Unchanged`.
- [`verify-release-artifacts.js`](../scripts/verify-release-artifacts.js) — the
  built files must be present and versioned. Expected names:
  `once-firefox-vX.Y.Z.xpi`, `once-chrome-vX.Y.Z.zip`,
  `*-X.Y.Z Setup.exe`, `*-X.Y.Z-full.nupkg`, `*-X.Y.Z.zip`, and `RELEASES`.
