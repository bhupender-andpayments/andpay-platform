import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { AppShell } from '../../src/ui/AppShell.js'
import { DataGrid, type GridColumn } from '../../src/ui/DataGrid.js'

// Task 1 (Phase 7 foundation): proves the ported design-system layer is
// present and wired, not just copied. Three independent assertions:
//   (a) AppShell renders its nav regions with the real section set.
//   (b) the ported token CSS layer actually resolves a custom property on
//       :root (not just textually present in the file).
//   (c) DataGrid renders rows from a plain props fixture with no network or
//       auth dependency.

describe('design-system foundation (Task 1)', () => {
  // Explicit cleanup: vitest.config.ts does not set test.globals, so RTL's
  // automatic afterEach never registers. This file had none, so every tree it
  // rendered stayed mounted past the test and into environment teardown. That
  // leak was invisible until AuthProvider gained a post-await setState, which
  // then ran against a torn-down jsdom and threw "window is not defined",
  // failing the whole run while every test still reported green.
  afterEach(() => { cleanup() })

  it('AppShell renders the main nav with the real section set', () => {
    render(
      <MemoryRouter initialEntries={['/dashboards']}>
        <AuthProvider>
          <AppShell>
            <div>page content</div>
          </AppShell>
        </AuthProvider>
      </MemoryRouter>,
    )
    const nav = screen.getByRole('navigation', { name: /main/i })
    // Reports is deliberately not in this list: HIDDEN_ROUTES drops it from the
    // sidebar (17 Aug 2026) while the Insights work is in flight.
    for (const label of ['Merchants', 'Command Center', 'Queues', 'Master Data', 'Uploads', 'Batches']) {
      expect(within(nav).getByText(label)).toBeTruthy()
    }
    expect(screen.getByText('page content')).toBeTruthy()
  })

  it('the design system token layer resolves its custom properties on :root', () => {
    // NodeURL (node:url's URL), not the jsdom-polyfilled global URL: under the
    // jsdom test environment the global URL resolves relative references
    // against the document's mock location (http://localhost:3000/) instead
    // of honoring a file: base, which silently produces the wrong path.
    const cssPath = fileURLToPath(new NodeURL('../../src/index.css', import.meta.url))
    // Inject ONLY the :root block. jsdom's CSS parser gives up on Tailwind v4's
    // at-rules (@import, @custom-variant, @theme inline) and silently drops
    // every rule after them, so feeding it the whole file makes every lookup
    // return ''. Brace-matched rather than regex-sliced so a nested block
    // cannot truncate it.
    const raw = readFileSync(cssPath, 'utf8')
    const rootAt = raw.indexOf(':root {')
    expect(rootAt).toBeGreaterThan(-1)
    let depth = 0
    let end = rootAt
    for (let i = raw.indexOf('{', rootAt); i < raw.length; i += 1) {
      if (raw[i] === '{') depth += 1
      else if (raw[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const css = raw.slice(rootAt, end)
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const read = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    // The token layer is now the design system spec's
    // (docs/design/ANDPAYMENTS-DESIGN-SYSTEM.md section 2), ported verbatim, so
    // this asserts THAT contract rather than the pre-spec token names.
    //
    // --primary is the AndPayments amber and --radius is the scale everything
    // else derives from; the spec calls both out as things a port gets wrong.
    expect(read('--primary')).toBe('oklch(0.745 0.155 65)')
    expect(read('--radius')).toBe('0.625rem')
    // Brand navy survives as a literal for the wordmark and auth headline, the
    // only two places the spec still uses it.
    expect(read('--brand-navy')).toBe('#08243e')
    // The sidebar is part of the ported contract too, and its amber active
    // item is the one thing a neutral-looking port loses first.
    expect(read('--sidebar-accent')).toBe('oklch(0.745 0.155 65)')
  })

  interface FixtureRow {
    id: string
    name: string
  }
  it('DataGrid renders rows from a props fixture', () => {
    const rows: FixtureRow[] = [
      { id: 'r1', name: 'Alpha' },
      { id: 'r2', name: 'Beta' },
    ]
    const columns: ReadonlyArray<GridColumn<FixtureRow>> = [
      { key: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
    ]
    render(<DataGrid columns={columns} rows={rows} getRowKey={(r) => r.id} searchable={false} />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
  })
})
