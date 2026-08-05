import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
    for (const label of ['Dashboards', 'Reports', 'Queues', 'Master Data', 'Uploads', 'Operations']) {
      expect(within(nav).getByText(label)).toBeTruthy()
    }
    expect(screen.getByText('page content')).toBeTruthy()
  })

  it('the ported token CSS layer resolves a custom property on :root', () => {
    // NodeURL (node:url's URL), not the jsdom-polyfilled global URL: under the
    // jsdom test environment the global URL resolves relative references
    // against the document's mock location (http://localhost:3000/) instead
    // of honoring a file: base, which silently produces the wrong path.
    const cssPath = fileURLToPath(new NodeURL('../../src/index.css', import.meta.url))
    const css = readFileSync(cssPath, 'utf8').replace(/@tailwind[^;]+;/g, '')
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const value = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
    expect(value).toBe('#3538cd')
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
