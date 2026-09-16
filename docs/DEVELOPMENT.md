# Development Guide

## Repository layout

```text
src/                  React interface and localization
src-tauri/src/        Rust desktop entry point and application services
src-tauri/            Tauri configuration and Windows bundle settings
PRODUCT.md            Product truth
DESIGN.md             Durable visual decisions
docs/                 Operational and architectural documentation
```

## Commands

Use Node.js 20 or newer with pnpm 11.13.1. The `packageManager` field in
`package.json` pins the project version.

```powershell
pnpm install
pnpm dev
pnpm tauri dev
pnpm lint
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

### Visual QA screenshots

`pnpm screenshots` starts the Vite app, opens the actual React interface in
the installed Microsoft Edge browser at a 2560×1440 viewport, and saves the
captured states under `artifacts/screenshots/`. The script injects
screenshot-only Tauri fixtures so visual review does not need a live mailbox,
OAuth session, or native Computer Use connection. These fixtures are never
loaded by the production application.

Useful options are `--width`, `--height`, `--headed`, `--no-server`, and
`--browser-path`:

```powershell
pnpm screenshots
pnpm screenshots -- --width 1440 --height 900
pnpm screenshots -- --headed
```

The portable build reads the Gmail OAuth client ID and secret plus the Microsoft
Graph public client ID from a `.env` file next to the executable at runtime.
For Microsoft Graph, the build environment remains a supported fallback. The
executable is written to `src-tauri/target/release/openmail.exe`.

The live verification target for this release cycle is Gmail. Outlook/Microsoft
Graph is validated only through compilation and unit tests until a public client
ID, tenant or consent configuration, and a dedicated test account are available.

## Diagnostics

The desktop shell writes application logs to Tauri's platform-specific log directory using the `openmail.log` file name. Gmail list, message, thread, inline image, and attachment operations include duration and item-count diagnostics at the `info` level. These diagnostics intentionally exclude message content, addresses, provider identifiers, access tokens, and refresh tokens.

When investigating a slow mailbox, compare the operation durations in the log with the visible action that triggered them. A successful list entry is written only after both message metadata and the history checkpoint have completed.

## Feature workflow

1. Define behavior and acceptance criteria.
2. Update English documentation when behavior changes.
3. Add or update English and Turkish translations for user-facing text.
4. Implement the smallest coherent change.
5. Test happy, failure, empty, loading, and permission states.
6. Run lint, frontend build, and Rust checks.
7. Commit the feature separately.

## UI rules

Use Tailwind v4 and owned shadcn primitives. Keep the account sidebar, focused content area, and custom window header consistent with `DESIGN.md`. Lucide Icons are not part of the project. The current shell does not include a footer; do not add one unless the product direction changes. Windows tray behavior and startup registration are implemented in the desktop shell and should be tested when changing window lifecycle code.
