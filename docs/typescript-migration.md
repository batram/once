# TypeScript Migration Plan: 4.9.5 → 5.9.x → 6.0.x

Branch: `migrate/typescript-6` · Written: 2026-07-12

## Goal

Move off TypeScript 4.9.5 and the dead-end lint stack (ESLint 7 + @typescript-eslint 4),
land on the latest TypeScript 6.0.x with no options that TypeScript 7 removes, so the
eventual 7.x jump is a version bump plus a webpack loader swap — not a re-architecture.

**Decision: keep typescript-eslint** (upgrade to v8 + ESLint 9 + flat config).
typescript-eslint v8 officially supports TypeScript `>=4.8.4 <6.1.0`, covering every step
of this plan. TS 7 support will come later via their new API work (or the documented
side-by-side `@typescript/typescript6` alias if we jump before they're ready).

## Environment facts (checked 2026-07-12)

| Item | Value | Notes |
| --- | --- | --- |
| Local Node / npm | 26.4.0 / 11.7.0 | no blockers for any step |
| CI Node | 24 (all jobs in `ci.yml`, `release.yml`) | LTS; fine |
| `engines` / `.nvmrc` | none | added in Step 0 |
| TS version landscape | 5.9.x (latest 5), 6.0.x (last JS-based compiler), 7.0.2 (Go, no programmatic API until 7.1) | |
| ts-loader usage | extension build (`scripts/webpack.webext.config.js`) + Electron Forge (`apps/electron/webpack.rules.js`, transpileOnly) | 9.4.4 installed; bump to latest 9.5.x |
| `npm run lint` | **does not exist** — ESLint only runs in VS Code today | added in Step 2 |
| Odd dep | `apps/electron` devDependency `"node": "24.18.0"` (installs a Node binary) | investigate separately; Electron bundles its own Node |

## Steps

Each step ends green and gets its own commit(s), so regressions bisect cleanly.

### Step 0 — Baseline and pinning

- [ ] Record a green baseline on current versions: `npm run check`, `npm test`, `npm run build-dev:firefox`
- [ ] Add `"engines": { "node": ">=24" }` to root `package.json`
- [ ] Add `.nvmrc` containing `24` (matches CI)

### Step 1 — TypeScript 4.9.5 → 5.9.x (compiler only, no config changes)

- [ ] Bump `typescript` to `^5.9`
- [ ] Bump `ts-loader` to latest 9.5.x
- [ ] **Deliberately keep** `moduleResolution: "node"` — deprecated-but-silent in 5.x;
      holding config constant isolates this step to pure compiler fallout
- [ ] Fix new type errors (six versions of lib.dom.d.ts updates + strictness improvements;
      `skipLibCheck: true` absorbs the stale `@types/pouchdb` / `@types/firefox-webext-browser`)
- [ ] Verify: full matrix (below)

Expected noise: @typescript-eslint 4.x warns it doesn't support TS 5.9 — harmless until Step 2.

### Step 2 — Lint stack: ESLint 9 + typescript-eslint v8 + flat config

- [ ] Bump `eslint` to `^9`, `@typescript-eslint/*` to the `typescript-eslint` v8 meta-package
- [ ] Migrate `.eslintrc.json` → `eslint.config.mjs` (flat config); the config is small:
      `eslint:recommended` + `tseslint.configs.recommended` + six stylistic rules
- [ ] Core stylistic rules (`indent`, `quotes`, `semi`, `comma-dangle`, `linebreak-style`)
      are frozen in ESLint 9 — move them to `@stylistic/eslint-plugin`
- [ ] Add `"lint": "eslint ."` root script; wire into `check` / `test:ci`
- [ ] Delete `.eslintrc.json`
- [ ] Verify: `npm run lint` clean (or document intentional rule relaxations)

### Step 3 — Retire node10 module resolution (the real 6/7 prep)

Split by how each surface consumes modules:

| Surface | Today | Target |
| --- | --- | --- |
| `packages/*` (emit real CJS consumed by `node --test` + electron) | inherits `commonjs` / `node` | `module: "nodenext"`, `moduleResolution: "nodenext"` (still emits CJS — no `"type": "module"` anywhere) |
| Root `tsconfig.json` (extension bundle via webpack + ts-loader) | inherits | `module: "esnext"`, `moduleResolution: "bundler"` |
| `apps/electron/tsconfig.json` | already `node16` | `nodenext` |

- [ ] Remove `module` / `moduleResolution` from `tsconfig.base.json`; set explicitly per surface
- [ ] Modernize `target` / `lib` from the stale `es6` / `es2019` mix to `es2022`
      (Electron 43, current Firefox and Chrome all support it)
- [ ] Expect friction: `nodenext` is stricter about `exports` maps in `packages/*/package.json`
      (they already have `types` + `default` conditions — likely fine);
      `bundler` resolution tightens some import patterns in extension code
- [ ] Verify: full matrix **plus runtime smoke** of the built Firefox extension and the
      Electron app — this step changes emitted output, not just types

### Step 4 — TypeScript 6.0.x

- [ ] Bump `typescript` to `^6.0` (latest patch; 6.0 is the only 6.x line — the last
      JS-based compiler before the Go-based 7)
- [ ] 6.0 turns remaining deprecations into errors; after Step 3 none should fire.
      Needing `"ignoreDeprecations": "6.0"` means Step 3 missed something — fix it there
- [ ] Bump `ts-loader` if a newer patch exists (changelog already has TS 6.0 fixes)
- [ ] typescript-eslint v8 supports `<6.1.0` — no lint changes needed
- [ ] Verify: full matrix

## Verification matrix

Run after every step:

```
npm run check:types
npm run lint            # exists from Step 2 on
npm run build:electron
npm test
npm run build-dev:firefox
npm run build:extensions:dev
```

Step 3 additionally: load the built Firefox extension and launch the Electron app
(`npm run start:electron`) as a runtime smoke test.

## Out of scope (deferred to the TS 7 jump, ~7.1 era)

- TypeScript 7: no programmatic API in 7.0 → ts-loader and typescript-eslint can't run on it.
  Revisit when 7.1 ships its new API and tooling declares support.
  Likely shape then: bump `typescript`, swap ts-loader → `swc-loader`/`esbuild-loader`
  (type-checking already runs separately via `check:types`), and either a typescript-eslint
  release with tsgo support or the `@typescript/typescript6` side-by-side alias.
- The `"node": "24.18.0"` devDependency in `apps/electron` — investigate/remove separately.
