import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLocalEnv } from '../../src/env.ts'

// loadLocalEnv() is what makes `npm run dev` see .env at all — under Docker, compose
// populates the environment instead and there is no file to read. The behavior worth
// pinning is the precedence rule: the real environment always beats the file, because a
// one-off `OPENAI_API_KEY=... npm run dev` and the e2e suite's deliberately-blank keys
// both have to survive the call.

let dir: string
let envFile: string
const TOUCHED = ['CATGEN_TEST_A', 'CATGEN_TEST_B', 'CATGEN_TEST_EMPTY']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'catgen-env-'))
  envFile = join(dir, '.env')
  for (const k of TOUCHED) delete process.env[k]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const k of TOUCHED) delete process.env[k]
})

describe('loadLocalEnv', () => {
  it('reads values out of the file into process.env', () => {
    writeFileSync(envFile, 'CATGEN_TEST_A=from_file\nCATGEN_TEST_B=also_from_file\n')
    expect(loadLocalEnv(envFile)).toBe(true)
    expect(process.env.CATGEN_TEST_A).toBe('from_file')
    expect(process.env.CATGEN_TEST_B).toBe('also_from_file')
  })

  it('leaves an already-set variable alone', () => {
    process.env.CATGEN_TEST_A = 'from_environment'
    writeFileSync(envFile, 'CATGEN_TEST_A=from_file\n')
    loadLocalEnv(envFile)
    expect(process.env.CATGEN_TEST_A).toBe('from_environment')
  })

  it('treats an explicitly blank variable as set, and does not backfill it', () => {
    // What playwright.config.ts does: blank the keys so every LLM control fails loudly.
    process.env.CATGEN_TEST_EMPTY = ''
    writeFileSync(envFile, 'CATGEN_TEST_EMPTY=a_real_key\n')
    loadLocalEnv(envFile)
    expect(process.env.CATGEN_TEST_EMPTY).toBe('')
  })

  it('reports false when there is no file, without throwing', () => {
    // The Docker path: compose supplies the environment and .dockerignore keeps .env
    // out of the image, so there is nothing here to read.
    expect(loadLocalEnv(join(dir, 'nope.env'))).toBe(false)
  })

  it('ignores comments and blank lines', () => {
    writeFileSync(envFile, '# a comment\n\nCATGEN_TEST_A=value\n')
    loadLocalEnv(envFile)
    expect(process.env.CATGEN_TEST_A).toBe('value')
  })

  it('keeps the value when a line carries a trailing comment', () => {
    // .env.example is written this way throughout — `STUDIO_API_TOKEN=  # bearer token…`
    writeFileSync(envFile, 'CATGEN_TEST_A=value # trailing note\n')
    loadLocalEnv(envFile)
    expect(process.env.CATGEN_TEST_A?.startsWith('value')).toBe(true)
  })
})
