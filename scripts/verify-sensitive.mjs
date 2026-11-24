#!/usr/bin/env node
/**
 * verify-sensitive.mjs - fail the build when internal information is committed.
 *
 * The repository is public (MIT), so nothing internal may reach it: no real host
 * addresses, no internal product names, no real personal directories, no credentials.
 * Run through "npm run check" and by hand before publishing.
 *
 *   node scripts/verify-sensitive.mjs            # scan every tracked file
 *   node scripts/verify-sensitive.mjs --list     # also print the matched text (local only)
 *
 * Exit code 1 with one "file:line rule" line per hit. Only placeholders documented in
 * docs/sensitive-data.md are allowed, and the allow-lists below are deliberate.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const wantList = process.argv.includes("--list")

/** Loopback and broadcast are the only IPv4 literals allowed (they are the local lab). */
const ALLOWED_IPV4 = new Set(["127.0.0.1", "0.0.0.0", "255.255.255.255"])

/** Documentation placeholder user names; anything else under /Users or /home is a leak. */
const PLACEHOLDER_USERS = new Set(["me", "user", "you", "somebody", "alice", "bob", "example", "dev", "someone"])

/** Domains that exist only as documentation examples. */
const EXAMPLE_DOMAINS = new Set(["example.com", "example.org", "example.net"])

/** Generated files and lockfiles are not hand-edited; they are still scanned, minus locks. */
const SKIP = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"])

// Fragments keep this file from tripping its own rules.
const PRODUCT_PREFIX = "byt" + "ed"
const INTERNAL_DOMAIN_PARTS = ["by" + "ted.org", "by" + "tedance.net", "co" + "rp.", "cod" + "e.by" + "ted."]
const PARTITION_PARTS = ["/da" + "ta0", "/op" + "t/tiger", "/m" + "nt/"]
const TOKEN_PREFIXES = ["gh" + "p_", "github_" + "pat_", "AK" + "IA"]
const PRIVATE_KEY_HEAD = "----" + "-BEGIN"
const BEARER = "Bear" + "er "
const PASSWORD_KEY = "pass" + "word="

/** Placeholder values that are fine after password= or Bearer. */
const PLACEHOLDER_VALUE = /^(?:<[^>]*>|x{3,}|\.{3,}|example|changeme|redacted|your[-_])/i

const rules = [
  {
    name: "ipv4-literal",
    find(line) {
      for (const match of line.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
        const value = match[0]
        if (ALLOWED_IPV4.has(value) === true) continue
        // A dotted quad immediately after a version label is a version, not an address:
        // crash records quote "v8=15.2.124.28-electron.0", and rewriting that number
        // would cost more accuracy than the false positive costs safety. The exception
        // is deliberately narrow — it only fires on the label itself.
        const before = line.slice(Math.max(0, match.index - 12), match.index)
        if (/(?:v8|electron|node|chrome|version)=$/i.test(before) === true) continue
        return value
      }
      return null
    },
  },
  {
    name: "internal-domain",
    find(line) {
      const lower = line.toLowerCase()
      for (const part of INTERNAL_DOMAIN_PARTS) {
        const at = lower.indexOf(part)
        if (at !== -1) return line.slice(at, at + 24)
      }
      const internalSuffix = new RegExp("\\." + "inter" + "nal\\b", "i")
      if (internalSuffix.test(line)) return "internal-suffix"
      return null
    },
  },
  {
    name: "internal-product-name",
    find(line) {
      const match = new RegExp("\\b" + PRODUCT_PREFIX + "[a-z0-9]*", "i").exec(line)
      return match === null ? null : match[0]
    },
  },
  {
    name: "personal-dir",
    find(line) {
      for (const match of line.matchAll(/\/(?:Users|home)\/([A-Za-z][A-Za-z0-9._-]*)/g)) {
        const name = match[1].toLowerCase()
        if (PLACEHOLDER_USERS.has(name) !== true) return match[0]
      }
      return null
    },
  },
  {
    name: "internal-partition-path",
    find(line) {
      for (const part of PARTITION_PARTS) {
        if (line.indexOf(part) !== -1) return part
      }
      return null
    },
  },
  {
    name: "credential",
    find(line) {
      for (const prefix of TOKEN_PREFIXES) {
        const at = line.indexOf(prefix)
        if (at !== -1) return prefix + "..."
      }
      // A real API key has a long high-entropy tail; "sk-blur" (a CSS class) must not match.
      const sk = /\bsk-[A-Za-z0-9]{20,}/.exec(line)
      if (sk !== null) return "sk-..."
      if (line.indexOf(PRIVATE_KEY_HEAD) !== -1) return "private-key"
      const bearer = new RegExp(BEARER + "(\\S{20,})").exec(line)
      if (bearer !== null && PLACEHOLDER_VALUE.test(bearer[1]) !== true) return "Bearer ..."
      const password = new RegExp(PASSWORD_KEY + "(\\S+)").exec(line)
      if (password !== null && PLACEHOLDER_VALUE.test(password[1]) !== true) return "password=..."
      return null
    },
  },
  {
    name: "real-email",
    find(line) {
      for (const match of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
        const domain = match[1].toLowerCase()
        if (EXAMPLE_DOMAINS.has(domain) !== true && domain.endsWith(".example") !== true) return match[0]
      }
      return null
    },
  },
]

/**
 * Scan tracked files AND untracked-but-not-ignored ones.
 *
 * `git ls-files` alone only sees what is already staged or committed, so a brand new
 * document could carry internal information straight through the gate: measured by
 * adding a file with a personal home path and a real integer address, where the first
 * run (before `git add`) reported zero hits. A leak must be caught before it is staged,
 * not after, so the untracked set is scanned too.
 */
function listFiles(args) {
  /**
   * Run git with a scrubbed environment.
   *
   * A shell can carry `GIT_CONFIG_VALUE_<n>` without the matching `GIT_CONFIG_KEY_<n>`
   * (an agent harness injects them). git then dies with "unable to parse command-line
   * config", and the sentinel would look broken instead of catching leaks. Only the
   * variables git needs are kept.
   */
  const env = {}
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (env.PATH === undefined) env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
  return execFileSync("git", args, { encoding: "utf8", env }).split("\u0000")
}
const files = Array.from(new Set([
  ...listFiles(["ls-files", "-z"]),
  ...listFiles(["ls-files", "--others", "--exclude-standard", "-z"]),
]))
  .filter((file) => file.length > 0 && SKIP.has(file) !== true)

const hits = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    continue
  }
  if (text.indexOf("\u0000") !== -1) continue
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of rules) {
      const found = rule.find(line)
      if (found === null) continue
      hits.push({ file, line: index + 1, rule: rule.name, text: found })
    }
  }
}

for (const hit of hits) {
  const suffix = wantList === true ? "  [" + hit.text + "]" : ""
  console.log(hit.file + ":" + hit.line + " " + hit.rule + suffix)
}

if (hits.length === 0) {
  console.log("verify-sensitive: no internal information found in " + files.length + " tracked files")
  process.exit(0)
}
console.log("")
console.log("verify-sensitive: " + hits.length + " hit(s). Replace them with the placeholders in docs/sensitive-data.md.")
process.exit(1)
