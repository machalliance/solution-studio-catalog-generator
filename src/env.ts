import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolved from this file rather than the working directory, so `.env` is found whether
// the server is started from the project root, from src/, or through an npm script.
// ENV_FILE overrides it — the same escape hatch CONFIG_PATH/SITES_PATH already give the
// paths in products/api.ts.
const DEFAULT_ENV_FILE = join(__dirname, '../.env')

// Reads .env into process.env before anything else in the app looks at it.
//
// This has to exist because nothing else does it. Under Docker, compose's `env_file: .env`
// populates the container's environment and this call finds no file to read (.dockerignore
// keeps .env out of the image) — a no-op, by design. But GETTING_STARTED.md offers
// `npm install && npm run dev` as an equal alternative, and on that path the process never
// saw .env at all: every model call failed with "no API key", Settings reported the key
// missing, and the file the docs just told you to write was being ignored with no
// indication why.
//
// Values already present in the environment win — that's what process.loadEnvFile() does,
// and it's the behavior that matters here: `OPENAI_API_KEY=... npm run dev` and the e2e
// suite's deliberately-blank keys both have to survive this call. An empty string counts
// as already-set, so a blank key stays blank rather than being backfilled from the file.
export function loadLocalEnv(file: string = process.env.ENV_FILE || DEFAULT_ENV_FILE): boolean {
  if (!existsSync(file)) return false
  // Added in Node 20.12. package.json asks for >=20.19, which the test toolchain forces
  // (rolldown, under vitest, publishes no binding below it). Warn rather than fail on an
  // older runtime — the app still works, it just needs the keys exported by hand, and a
  // silent no-op here is exactly the confusion this function exists to remove.
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(
      `Found ${file} but this Node (${process.version}) can't read it — process.loadEnvFile() ` +
      `needs Node 20.12+. Export the variables yourself, or upgrade Node.`,
    )
    return false
  }
  try {
    const before = new Set(Object.keys(process.env))
    process.loadEnvFile(file)
    warnOnMalformedKeys(file, before)
    return true
  } catch (err: any) {
    // A malformed .env shouldn't take the server down — say so and carry on with whatever
    // the environment already holds.
    console.warn(`Could not read ${file}: ${err.message}`)
    return false
  }
}

// Node's .env parser got more tolerant over time, and the gap is silent: an indented
// comment line — the shape you get by pasting a key over the value in .env.example and
// letting the trailing comment wrap onto its own line —
//
//     ANTHROPIC_API_KEY=sk-ant-...
//           # required for anthropic/* models on this route
//     OPENAI_API_KEY=sk-proj-...
//
// is skipped as a comment on Node 22+, but on Node 20 is read as the beginning of a key
// name, which then runs on to the '=' of the *next* line. The result is one nonsense
// variable holding the second key's value, and the second key never set at all — with no
// error anywhere. Rather than re-implement the parser, spot the signature of that failure
// (a name carrying a newline or starting with '#') and say plainly what to change.
//
// Only names the file just introduced are considered, so a genuinely odd variable already
// in the environment isn't blamed on the file. Names only, never values: the mis-parsed
// variable's value is the API key itself.
export function warnOnMalformedKeys(file: string, before: ReadonlySet<string> = new Set()): string[] {
  const bad = Object.keys(process.env)
    .filter(k => !before.has(k))
    .filter(k => k.includes('\n') || k.trimStart().startsWith('#'))
  if (!bad.length) return bad
  console.warn(
    `${file} has a comment on its own indented line, which this Node (${process.version}) ` +
    `does not recognise — the variable after it was not set. Move each comment to a line ` +
    `that starts with '#' in column 1, or put it on the end of the value's own line.`,
  )
  for (const k of bad) {
    const shown = k.split('\n')[0].trim().slice(0, 60)
    console.warn(`  unparsed near: ${shown}`)
  }
  return bad
}

// Runs on import. server.ts imports this module first, before products/api.ts, because
// api.ts reads process.env at module scope and ES module bodies evaluate in import order.
//
// Skipped under vitest: the unit suite deletes ANTHROPIC_API_KEY/OPENAI_API_KEY to assert
// what the routes do with no credentials configured, and a developer's real .env would
// silently put them back and turn those assertions into live API calls.
if (!process.env.VITEST) loadLocalEnv()
