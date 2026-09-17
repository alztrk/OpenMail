#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const requestedVersion = process.argv[2]?.replace(/^v/, '')

if (!requestedVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
  console.error('Usage: pnpm version:set <major.minor.patch[-prerelease]>')
  process.exit(1)
}

const packagePath = path.join(projectRoot, 'package.json')
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json')
const cargoPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml')

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
packageJson.version = requestedVersion

const tauriConfig = JSON.parse(await readFile(tauriConfigPath, 'utf8'))
tauriConfig.version = requestedVersion

const cargoToml = await readFile(cargoPath, 'utf8')
const cargoVersionPattern = /(\[package\][\s\S]*?\nversion = ")[^"]+/
if (!cargoVersionPattern.test(cargoToml)) {
  console.error('Could not find the package version in src-tauri/Cargo.toml')
  process.exit(1)
}
const updatedCargoToml = cargoToml.replace(
  cargoVersionPattern,
  `$1${requestedVersion}`,
)

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, 'utf8')
await writeFile(cargoPath, updatedCargoToml, 'utf8')

console.log(`OpenMail version synchronized to ${requestedVersion}`)
