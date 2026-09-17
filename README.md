# OpenMail

OpenMail is a lightweight, local-first Windows desktop mail client for bringing personal Gmail and Microsoft mailboxes into one focused workspace.

## Project status

OpenMail is under active development. The repository currently contains the Tauri desktop shell, localized UI, Gmail and Microsoft account OAuth with PKCE, local mailbox caching, incremental synchronization, HTML mail rendering, desktop notifications, Windows tray controls, and the product and design records.

Verification currently targets Gmail for live end-to-end testing. Microsoft Graph
is compile-checked and covered by unit tests, but is not live-tested in this
release cycle because its public client ID, tenant or consent configuration,
and a test account are not available.

## Principles

- Mail content stays on the user's device.
- No OpenMail-hosted mailbox backend is required.
- OAuth 2.0 + PKCE is used instead of collecting mailbox passwords.
- The application should remain lightweight and quick on Windows.
- Only one OpenMail desktop instance runs at a time; a second launch focuses the existing window.
- Scheduled messages are kept in an encrypted, machine-local queue and are processed while OpenMail is running, including after the app is reopened.
- Local accounts, cached mail, and scheduled messages can be exported to and restored from a passphrase-encrypted backup; OAuth tokens are intentionally excluded and accounts must be reconnected after restore.
- Diagnostic logs are stored locally by Tauri under `%LOCALAPPDATA%\com.openmail.desktop\logs`; they record operation timings and counts without storing mail content, credentials, tokens, or account addresses.
- The optional app lock stores its PIN in Windows Credential Manager; the PIN is not persisted in browser storage.
- User-facing application text is localized in English, Turkish, German, Spanish, French, and Brazilian Portuguese.
- Product documentation is maintained in English.

## Stack

- Tauri 2 and Rust for the Windows desktop shell.
- React and TypeScript for the interface.
- Tailwind CSS v4 for utility styling.
- shadcn/ui for owned component primitives.
- Authenticated encrypted JSON files for local account metadata and message cache during the current MVP.
- Encrypted local scheduled-message queue for deferred sending.
- Passphrase-encrypted local backup and restore for account metadata, cached mail, and scheduled messages.
- i18next and react-i18next for localization.

## Development

Prerequisites: Windows 10 or newer, Node.js 20 or newer with pnpm 11.13.1,
Rust 1.85 or newer with the MSVC toolchain, and Microsoft WebView2 Runtime. The
`packageManager` field pins the pnpm version used by the project.

```powershell
pnpm install
pnpm tauri dev
```

Run the checks:

```powershell
pnpm lint
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Synchronize the application version across the frontend package, Cargo package,
and Tauri configuration:

```powershell
pnpm version:set 0.2.0
```

## GitHub releases and updates

Pushing a tag such as `v0.2.0`, or starting the `Release OpenMail` workflow
manually with a version, builds the signed Windows NSIS/MSI installers and the
portable executable, then publishes them to a GitHub Release. The Tauri updater
metadata is published as `latest.json` alongside the release assets so installed
copies can discover it.

The updater accepts only artifacts signed by the configured Tauri public key.
The private signing key is never stored in this repository or embedded in the
application. Before running the workflow, configure these repository values in
GitHub Actions:

- Repository variable `TAURI_UPDATER_PUBLIC_KEY` with the public key matching
  the signing key.
- Repository secret `TAURI_SIGNING_PRIVATE_KEY` with the private key contents.
- Repository secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with its password. It
  may be empty only if the chosen signing key has no password.

In the installed application, open Settings and use Application updates to
check for a signed release. A check runs automatically after startup as well;
installation remains user-controlled and restarts the application after the
installer completes.

Build the Windows portable release:

```powershell
pnpm tauri build --no-bundle
```

The portable release is a single `openmail.exe`. Start it, open Settings, and
enter the provider application values in OAuth credentials. OpenMail stores
them in Windows Credential Manager and never embeds them in the binary or
account data. Gmail requires both a desktop client ID and client secret;
Microsoft Graph requires only its public client ID.

## MCP integration

OpenMail includes a local MCP server binary named `openmail-mcp`. It uses the
same encrypted local account and cache directory as the desktop app, does not
expose OAuth tokens or client secrets, opens no network port, and communicates
with MCP clients over standard input and output.

Build and run it during development:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --bin openmail-mcp
```

By default the server exposes only read tools: `list_accounts`,
`list_mailboxes`, `list_messages`, `get_message`, and `get_thread`. Draft and
mutation tools are not even advertised unless their corresponding opt-in flag
is passed:

- `--allow-drafts` enables `list_drafts`, `get_draft`, `save_draft`, and
  `delete_draft`.
- `--allow-actions` enables `modify_message` and `modify_messages` for mailbox
  actions such as archive, mark read, star, spam, and trash.
- `--allow-send` enables `send_message` and `reply_to_message`.
- `--allow-delete` enables permanent deletion through the modify tools. It
  does not enable ordinary mailbox actions by itself.

Every mutating tool requires `confirm: true`. Draft save, send, and reply
additionally require a caller-supplied `idempotency_key`; repeated calls with
the same key and payload return the original result during that MCP process,
while reusing a key with a different payload is rejected. The account's
registered address is always used as the sender. `send_message` and `save_draft`
also accept optional standard-base64 attachment payloads. MCP limits each
request to 10 attachments and less than 25 MiB combined, rejects path
separators and control characters in filenames, and validates the MIME type and
decoded bytes before calling a provider. `reply_to_message` remains
text/HTML-only until the provider reply contract supports attachments.

Message list results contain summaries; full message content is available only
through the explicit detail tools and is bounded before it is returned. Mail
content must be treated as untrusted data by the MCP client because it can
contain arbitrary instructions.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "openmail": {
      "command": "C:\\Program Files\\OpenMail\\openmail-mcp.exe"
    }
  }
}
```

For a client that needs draft editing but no sending, pass arguments such as:

```json
{
  "mcpServers": {
    "openmail-drafts": {
      "command": "C:\\Program Files\\OpenMail\\openmail-mcp.exe",
      "args": ["--allow-drafts"]
    }
  }
}
```

The desktop app must have completed account authorization before the MCP server
can read or mutate a provider mailbox. Read operations use the provider
adapters directly and do not mutate OpenMail's local cache. Mailbox action
tools update the local cache after a successful provider operation. Installer
packages include the MCP sidecar. For portable releases, download
`openmail-mcp.exe` alongside `openmail.exe` and point the MCP client to that
separate executable.

## Localization

Translations live in `src/locales/`. Supported locale codes are `en`, `tr`, `de`, `es`, `fr`, and `pt-BR`. The shared locale registry is defined in `src/locale-config.ts`. New user-facing text must be added to every locale file, preserve the same interpolation placeholders, and be referenced by a stable key from React components.

## Documentation map

- [Product record](PRODUCT.md)
- [Design system](DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Provider integration plans](docs/providers/README.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Local data and privacy](docs/PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE.md)

## License

OpenMail is available for free noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use, including selling the project or a product based on it, requires separate written permission from the copyright holder.
