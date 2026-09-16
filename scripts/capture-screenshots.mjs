#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')

const fixtureAccount = {
  id: 'screenshot-account',
  address: 'review@example.test',
  provider: 'gmail',
  is_default: true,
}

const fixtureMessages = [
  {
    id: 'screenshot-message-1',
    account_id: fixtureAccount.id,
    thread_id: 'screenshot-thread-1',
    message_id_header: '<screenshot-message-1@example.test>',
    sender: 'Design Review',
    address: 'design@example.test',
    subject: 'A clearer inbox at a glance',
    preview: 'The latest review notes are ready to read.',
    body: 'The latest review notes are ready to read. This fixture exists only for visual QA.',
    body_html: '<p>The latest review notes are ready to read.</p><p>This fixture exists only for visual QA.</p>',
    avatar_url: null,
    time: '2026-09-15T09:13:00.000Z',
    unread: true,
    starred: false,
    hasAttachment: false,
    attachments: [],
  },
  {
    id: 'screenshot-message-2',
    account_id: fixtureAccount.id,
    thread_id: 'screenshot-thread-1',
    message_id_header: '<screenshot-message-2@example.test>',
    sender: 'Design Review',
    address: 'design@example.test',
    subject: 'Re: A clearer inbox at a glance',
    preview: 'I added the spacing and typography notes.',
    body: 'I added the spacing and typography notes. The attached checklist is included for the review.',
    body_html: '<p>I added the spacing and typography notes.</p><p>The attached checklist is included for the review.</p>',
    avatar_url: null,
    time: '2026-09-15T08:47:00.000Z',
    unread: false,
    starred: true,
    hasAttachment: true,
    attachments: [{ id: 'screenshot-attachment-1', filename: 'review-checklist.pdf', mime_type: 'application/pdf', size: 184320 }],
  },
  {
    id: 'screenshot-message-3',
    account_id: fixtureAccount.id,
    thread_id: 'screenshot-thread-3',
    message_id_header: '<screenshot-message-3@example.test>',
    sender: 'Product Updates',
    address: 'updates@example.test',
    subject: 'What changed this week',
    preview: 'A concise summary of the most recent product changes.',
    body: 'A concise summary of the most recent product changes.',
    body_html: '<p>A concise summary of the most recent product changes.</p>',
    avatar_url: null,
    time: '2026-09-14T16:20:00.000Z',
    unread: false,
    starred: false,
    hasAttachment: false,
    attachments: [],
  },
]

const fixtureFolderMessages = {
  inbox: fixtureMessages,
  sent: [
    {
      ...fixtureMessages[0],
      id: 'screenshot-sent-1',
      thread_id: 'screenshot-sent-thread',
      sender: 'You',
      address: fixtureAccount.address,
      subject: 'A note from the review',
      preview: 'Thanks for the thoughtful feedback.',
      body: 'Thanks for the thoughtful feedback.',
      body_html: '<p>Thanks for the thoughtful feedback.</p>',
      unread: false,
      starred: false,
      hasAttachment: false,
      attachments: [],
    },
  ],
  spam: [],
  trash: [],
}

const fixtureCapabilities = {
  can_search: true,
  can_send: true,
  can_reply: true,
  can_archive: true,
  can_delete: true,
  can_permanently_delete: true,
  can_mark_read: true,
  can_star: true,
  can_spam: true,
  supports_incremental_sync: true,
  supports_html: true,
  supports_attachments: true,
}

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:5173/',
    output: path.join('artifacts', 'screenshots'),
    width: 2560,
    height: 1440,
    headed: false,
    noServer: false,
    browserPath: null,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--headed') {
      options.headed = true
      continue
    }
    if (argument === '--no-server') {
      options.noServer = true
      continue
    }
    if (argument === '--url' || argument === '--output' || argument === '--width' || argument === '--height' || argument === '--browser-path') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`)
      index += 1
      if (argument === '--url') options.url = value
      if (argument === '--output') options.output = value
      if (argument === '--width') options.width = Number(value)
      if (argument === '--height') options.height = Number(value)
      if (argument === '--browser-path') options.browserPath = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (!Number.isInteger(options.width) || options.width < 320) throw new Error('--width must be an integer of at least 320.')
  if (!Number.isInteger(options.height) || options.height < 240) throw new Error('--height must be an integer of at least 240.')
  return options
}

function usage() {
  return `Usage: pnpm screenshots [options]

Options:
  --width <px>       Viewport width. Defaults to 2560.
  --height <px>      Viewport height. Defaults to 1440.
  --output <path>    Screenshot directory. Defaults to artifacts/screenshots.
  --url <url>        Existing Vite URL when --no-server is used.
  --headed           Show the browser while capturing.
  --browser-path <p> Use a specific Chromium-compatible browser executable.
  --no-server        Do not start pnpm dev; use the supplied URL.
  --help             Show this help.
`
}

function createTauriMockScript() {
  const account = JSON.stringify(fixtureAccount)
  const messages = JSON.stringify(fixtureMessages)
  const folders = JSON.stringify(fixtureFolderMessages)
  const capabilities = JSON.stringify(fixtureCapabilities)

  return `(() => {
  const account = ${account};
  const messages = ${messages};
  const folders = ${folders};
  const capabilities = ${capabilities};
  const callbacks = new Map();
  let callbackId = 0;

  const copy = (value) => JSON.parse(JSON.stringify(value));
  const pageFor = (folder = 'inbox', query = '') => {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const source = folders[folder] || messages;
    const filtered = normalizedQuery.length === 0
      ? source
      : source.filter((message) => [message.sender, message.address, message.subject, message.preview, message.body].join(' ').toLowerCase().includes(normalizedQuery));
    return { messages: copy(filtered), next_page_token: null, history_id: 'screenshot-history' };
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback(callback, once = false) {
      const id = ++callbackId;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(filePath) {
      return String(filePath);
    },
    async invoke(command, args = {}) {
      switch (command) {
        case 'list_accounts':
          return copy([account]);
        case 'get_provider_capabilities':
          return copy(capabilities);
        case 'get_cached_messages':
        case 'list_messages':
          return pageFor('inbox');
        case 'get_cached_folder_messages':
        case 'list_folder_messages':
          return pageFor(args.folder || 'inbox');
        case 'cache_folder_messages':
        case 'cache_search_messages':
          return null;
        case 'sync_messages':
          return { page: pageFor('inbox'), new_message_count: 0, removed_message_ids: [] };
        case 'search_cached_messages':
        case 'search_messages':
          return pageFor('inbox', args.query);
        case 'get_cached_thread':
        case 'get_thread':
          return copy(messages.filter((message) => message.thread_id === args.threadId));
        case 'get_message':
          return copy(messages.find((message) => message.id === args.messageId) || messages[0]);
        case 'list_drafts':
          return [];
        case 'save_draft':
          return { id: 'screenshot-draft', subject: args.subject || '', recipient: args.recipient || '', cc: args.cc || '', bcc: args.bcc || '', body: args.body || '', bodyHtml: args.bodyHtml || '', attachments: args.attachments || [], updatedAt: new Date().toISOString() };
        case 'send_message':
          return 'screenshot-sent-message';
        case 'remove_account':
          return [];
        case 'plugin:event|listen':
          return callbackId + 1;
        case 'plugin:event|unlisten':
        case 'plugin:notification|send_notification':
        case 'plugin:window|close':
        case 'plugin:window|minimize':
        case 'plugin:window|hide':
        case 'plugin:window|toggle_maximize':
        case 'hide_main_window':
        case 'open_external_url':
        case 'set_launch_at_startup':
        case 'modify_message':
          return null;
        case 'plugin:notification|is_permission_granted':
          return false;
        case 'plugin:notification|request_permission':
          return 'denied';
        case 'plugin:window|is_maximized':
          return false;
        default:
          return null;
      }
    },
  };
})();`
}

function startViteServer(url) {
  const parsedUrl = new URL(url)
  const port = parsedUrl.port || '5173'
  const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `pnpm dev --host ${parsedUrl.hostname} --port ${port}`]
    : ['dev', '--host', parsedUrl.hostname, '--port', port]
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return { child, getOutput: () => output }
}

async function waitForServer(url, server) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready.\n${server.getOutput().trim()}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}.\n${server.getOutput().trim()}`)
}

function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  if (process.platform === 'win32' && server.child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(server.child.pid), '/t', '/f'], { stdio: 'ignore' })
    if (result.status !== 0 && server.child.exitCode === null) server.child.kill()
    return
  }
  server.child.kill('SIGTERM')
}

async function resolveBrowserPath(browserPath) {
  if (browserPath) {
    await access(browserPath)
    return browserPath
  }
  if (process.platform !== 'win32') return null
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next standard installation location.
    }
  }
  throw new Error('Microsoft Edge was not found. Pass --browser-path with a Chromium-compatible browser executable.')
}

async function waitForApp(page) {
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForFunction(() => {
    const messageList = document.querySelector('.message-list')
    return messageList !== null && messageList.getAttribute('aria-busy') !== 'true'
  }, undefined, { timeout: 10000 })
  await page.waitForTimeout(250)
}

async function openFresh(page, url) {
  await page.goto(url, { waitUntil: 'commit' })
  await waitForApp(page)
}

async function capture(page, outputDirectory, name, captures) {
  const filePath = path.resolve(outputDirectory, `${name}.png`)
  await page.screenshot({ path: filePath, fullPage: false, animations: 'disabled', caret: 'hide' })
  captures.push({ name, path: filePath })
}

async function captureScreens(page, outputDirectory, url) {
  const captures = []

  await openFresh(page, url)
  await page.locator('[data-mail-id]').first().waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '01-inbox', captures)

  await page.locator('[data-mail-id]').first().click()
  await page.locator('.mail-reader').waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '02-reader', captures)

  await openFresh(page, url)
  await page.locator('.folder-nav-item').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.message-list')?.getAttribute('aria-busy') !== 'true', undefined, { timeout: 10000 })
  await capture(page, outputDirectory, '03-sent', captures)

  await openFresh(page, url)
  await page.locator('.folder-nav-item').nth(2).click()
  await page.waitForFunction(() => document.querySelector('.message-list')?.getAttribute('aria-busy') !== 'true', undefined, { timeout: 10000 })
  await capture(page, outputDirectory, '04-spam-empty', captures)

  await openFresh(page, url)
  await page.locator('.settings-button').click()
  await page.locator('.settings-layout').waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '05-settings-general', captures)

  for (const [index, name] of [[1, '06-settings-appearance'], [2, '07-settings-language'], [3, '08-settings-notifications'], [4, '09-settings-accounts']]) {
    await page.locator('.settings-tab').nth(index).click()
    await page.locator('.settings-layout').waitFor({ state: 'visible', timeout: 10000 })
    await capture(page, outputDirectory, name, captures)
  }

  await page.locator('.account-add-button').click()
  await page.locator('.provider-action-cards').waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '10-settings-add-account', captures)

  await openFresh(page, url)
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click()
  await page.locator('.compose-page').waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '11-compose', captures)

  await openFresh(page, url)
  const search = page.getByRole('combobox', { name: /Search mail/i })
  await search.fill('design')
  await page.locator('.search-results-dialog').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-search-result-index]').first().waitFor({ state: 'visible', timeout: 10000 })
  await capture(page, outputDirectory, '12-search-results', captures)

  return captures
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const outputDirectory = path.resolve(projectRoot, options.output)
  await mkdir(outputDirectory, { recursive: true })

  let server
  let browser
  try {
    if (!options.noServer) {
      server = startViteServer(options.url)
      await waitForServer(options.url, server)
    } else {
      const response = await fetch(options.url)
      if (!response.ok) throw new Error(`The existing screenshot URL returned HTTP ${response.status}.`)
    }

    const browserPath = await resolveBrowserPath(options.browserPath)
    browser = await chromium.launch({
      ...(browserPath ? { executablePath: browserPath } : {}),
      headless: !options.headed,
    })
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
    })
    await context.addInitScript({ content: createTauriMockScript() })
    const page = await context.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const captures = await captureScreens(page, outputDirectory, options.url)
    const manifest = {
      generatedAt: new Date().toISOString(),
      viewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
      source: 'React UI with screenshot-only Tauri fixtures',
      captures: captures.map((captureItem) => ({ ...captureItem, relativePath: path.relative(projectRoot, captureItem.path) })),
    }
    await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(manifest, null, 2))
  } finally {
    await browser?.close()
    stopServer(server)
  }
}

main().catch((error) => {
  console.error(`[screenshots] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
