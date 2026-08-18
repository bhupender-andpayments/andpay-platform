import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ReturnUploadPage } from '../../src/features/uploads/ReturnUploadPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { stageFile, takeStagedFile } from '../../src/lib/stagedFile.js'

// Task 9: the staged-file handoff Task 10's smart upload page will use. A
// caller stages a File before navigating here; on mount the page consumes it
// exactly as if the operator had dropped it into the zone themselves, which
// for ReturnUploadPage means firing the preview POST with no user interaction.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const RETURN_PREVIEW_RESULT = {
  structuralErrors: [],
  validRows: [{ asgnId: 'asgn_1', awb: 'AWB1', deviceSerial: '869123450000001', courierCode: 'BD' }],
  invalidRows: [],
}

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function renderWithProviders(ui: ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('staged file handoff', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
    // Nothing should leak between tests: a staged file consumed by one test
    // must not silently surface in the next.
    takeStagedFile()
  })
  afterEach(() => {
    cleanup()
  })

  it('a staged file fires the preview POST on mount, with no user interaction, and the dropzone shows its name', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/return/preview')) return jsonResponse(RETURN_PREVIEW_RESULT)
        return jsonResponse({})
      }),
    )

    stageFile(makeFile('x', 'staged-return.csv'))
    renderWithProviders(<ReturnUploadPage />)

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/return/preview'))).toBe(true)
    })
    expect(await screen.findByText('staged-return.csv')).toBeTruthy()
  })

  it('no staged file means no fetch on mount', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({})
      }),
    )

    renderWithProviders(<ReturnUploadPage />)
    await screen.findByText(/print vendor return/i)

    expect(calls.length).toBe(0)
  })
})
