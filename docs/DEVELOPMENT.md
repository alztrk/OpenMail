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
npm run tauri build
```

## Feature workflow

1. Define behavior and acceptance criteria.
2. Update English documentation when behavior changes.
3. Add or update English and Turkish translations for user-facing text.
4. Implement the smallest coherent change.
5. Test happy, failure, empty, loading, and permission states.
6. Run lint, frontend build, and Rust checks.
7. Review the diff for secrets and unrelated edits.
8. Commit the feature separately.

## UI rules

Use Tailwind v4 and owned shadcn primitives. Keep the account sidebar, focused content area, custom window header, and functional status footer consistent with `DESIGN.md`. Lucide Icons are not part of the project.
