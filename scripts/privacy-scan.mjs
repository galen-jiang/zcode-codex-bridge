#!/usr/bin/env node
// Scans this package for accidentally committed private content:
// absolute user/home paths, personal model preferences, and email addresses.
// Generic checks only — this scanner never embeds any real identifier.
// Exit 0 when clean; every hit is printed with file and pattern name.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] ?? new URL('..', import.meta.url).pathname
const patterns = [
  ['absolute-user-path', /\/Users\/[A-Za-z0-9._-]+/g],
  ['home-user-dir', /\/home\/[A-Za-z0-9._-]+/g],
  ['model-preference', /GLM-5\.3-Flash/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
]
let hits = 0
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (/\.(png|jpg|pyc)$/.test(entry.name)) continue
    const text = readFileSync(full, 'utf8')
    for (const [name, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        hits += 1
        const line = text.slice(0, match.index).split('\n').length
        console.log(`HIT ${name} ${relative(root, full)}:${line}`)
      }
    }
  }
}
walk(root)
console.log(hits === 0 ? 'PRIVACY_SCAN_CLEAN' : `PRIVACY_SCAN_HITS=${hits}`)
process.exit(hits === 0 ? 0 : 1)
