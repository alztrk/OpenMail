# Contributing to OpenMail

Thank you for helping improve OpenMail. Contributions should preserve the local-first behavior, Windows focus, lightweight runtime, and bilingual interface.

## Before opening a change

1. Read `PRODUCT.md` and `DESIGN.md`.
2. Check existing issues and avoid duplicating active work.
3. Keep the change focused on one feature or fix.
4. Do not include credentials, OAuth tokens, mailbox content, private attachments, or personal data.

## Local checks

```powershell
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

For UI changes, verify keyboard focus, empty and error states, English and Turkish text, narrow-window behavior, and a real Tauri render.

## Commit convention

Use small conventional commits. Each user-visible feature should have its own commit.

```text
feat(gmail): add OAuth authorization
fix(sync): recover after expired history cursor
docs: document local mailbox storage
```

## Pull requests

Describe the behavior, changed files, checks run, and known limitations. Screenshots must not contain real mailbox content or credentials.
