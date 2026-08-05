import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { join } from 'node:path'

// Phase 7 Task 13a (L13 demo-bridge exclusion proof). Resolved via
// import.meta.url, NEVER process.cwd() (Task 1's foundation.test.tsx hit
// exactly this defect under the root vitest run: process.cwd() is the repo
// root, not this file's directory, so a CWD-relative path silently resolves
// to the wrong file when the suite is invoked from a different directory).
//
// What each demo bridge actually was (grounded against
// docs/plan/phase7_grounding/A_demo_screens.md and the demo branch's own
// apps/ops-portal/demo/serve.mjs + demo/README.md, read via `git show`, never
// checked out):
//   - a demo `roleConfig` injected into ops-edge deps, bridging the auth-role
//     vocabulary onto ops write permissions (serve.mjs: `opsDeps.roleConfig =
//     {...}`). ops-portal src has no legitimate reason to reference
//     `roleConfig` at all (it is an edge-only RoleConfig concept); its
//     presence in any portal source file would mean this bridge (or a
//     portal-side reproduction of it) got copied in.
//   - `authenticator.options = { window: [10, 10] }`, widening the TOTP
//     acceptance window for a seeded demo operator's convenience.
//   - BRIDGE-1, the ops-edge raw-UUID vendor-id bridge (A_demo_screens.md
//     section 2): `const vndrId = id.includes('_') ? id : fromUuid('vndr',
//     id)`, imported from `@andpay/ids`. That bridge lives in ops-edge, not
//     ops-portal, so the portal-side guard is that no portal src file
//     imports `@andpay/ids` or calls `fromUuid(...)` to reproduce the same
//     encode-a-raw-uuid trick client-side (VendorSuspendButton.tsx already
//     documents sending the WIRE vndr id verbatim from getVendors, never a
//     raw uuid it re-encodes).
//   - the hardcoded seeded demo operator (demo/operators.mjs): handle
//     `ops.admin`, password `demo-Ops-2026!`, and its fixed placeholder
//     principal uuid `99999999-9999-4999-8999-999999999999`.

const SRC_DIR = fileURLToPath(new NodeURL('../../src', import.meta.url))
const DEMO_DIR = fileURLToPath(new NodeURL('../../demo', import.meta.url))

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const SOURCE_FILES = collectSourceFiles(SRC_DIR)

function findOffenders(pattern: RegExp): string[] {
  return SOURCE_FILES.filter((file) => pattern.test(readFileSync(file, 'utf8')))
}

describe('demo-bridge exclusion guard (Phase 7 Task 13a, L13)', () => {
  it('apps/ops-portal/demo/ does not exist', () => {
    expect(existsSync(DEMO_DIR)).toBe(false)
  })

  it('no src file references the demo roleConfig bridge', () => {
    expect(findOffenders(/roleConfig/)).toEqual([])
  })

  it('no src file carries the widened demo TOTP acceptance window', () => {
    expect(findOffenders(/window:\s*\[\s*10\s*,\s*10\s*\]/)).toEqual([])
  })

  it('no src file imports @andpay/ids or calls fromUuid (the ops-edge raw-uuid vendor bridge, BRIDGE-1, reproduced client-side)', () => {
    expect(findOffenders(/from\s+['"]@andpay\/ids['"]/)).toEqual([])
    expect(findOffenders(/\bfromUuid\s*\(/)).toEqual([])
  })

  it('no src file hardcodes the seeded demo operator handle, password, or placeholder principal id', () => {
    expect(findOffenders(/ops\.admin/)).toEqual([])
    expect(findOffenders(/demo-Ops-2026!/)).toEqual([])
    expect(findOffenders(/99999999-9999-4999-8999-999999999999/)).toEqual([])
  })
})
