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

```powershell
npm install
npm run dev
npm run tauri dev
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

The portable build reads the configured public Gmail OAuth client identifier from
`src-tauri/src/config.rs` and writes the executable to
`src-tauri/target/release/openmail.exe`.

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
