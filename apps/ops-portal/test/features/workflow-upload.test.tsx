import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { UploadStage } from '../../src/features/workflow/stages/UploadStage.js'
import { ValidateStage } from '../../src/features/workflow/stages/ValidateStage.js'
import type { BankPreviewResult } from '../../src/api/endpoints.js'

const PREVIEW: BankPreviewResult = {
  rows: [
    { rowNo: 1, valid: true, errors: [], row: {
      fileId: 'f', rowNo: 1, bankMerchantReference: 'R1', displayName: 'Acme', legalName: 'ACME LTD',
      mcc: '5411', registeredAddress: 'addr', bankReferenceCode: 'HDFC001', productType: 'SOUNDBOX',
      vpaValue: 'a@bank', qrValue: 'qr', soundbox: true, standeeCount: 0, stickerCount: 0,
      shipToAddress: 'ship', contactName: 'C', mobile: '9990000001', branchCode: 'BR1',
    } },
    { rowNo: 2, valid: false, errors: ['duplicate_vpa_soundbox'], row: {
      fileId: 'f', rowNo: 2, bankMerchantReference: 'R2', displayName: 'Dup', legalName: 'DUP LTD',
      mcc: '5411', registeredAddress: 'addr', bankReferenceCode: 'HDFC001', productType: 'SOUNDBOX',
      vpaValue: 'a@bank', qrValue: 'qr', soundbox: true, standeeCount: 0, stickerCount: 0,
      shipToAddress: 'ship', contactName: 'C', mobile: '9990000002', branchCode: 'BR1',
    }, duplicateOf: { kind: 'assignment', reference: 'asgn_9', merchantDisplayName: 'Acme' } },
  ],
  summary: { total: 2, valid: 1, invalid: 1 },
  structuralErrors: [],
}

function wrap(node: React.ReactNode) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{node}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('workflow stage 1: Upload', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders the drop zone', () => {
    wrap(<UploadStage file={null} previewing={false} error={null} onPick={() => {}} />)
    expect(screen.getByLabelText(/bank request file/i)).toBeTruthy()
  })

  it('surfaces an error the page handed it, such as the 5 MB rejection', () => {
    wrap(<UploadStage file={null} previewing={false} error="File exceeds the 5 MB upload limit." onPick={() => {}} />)
    expect(screen.getByRole('alert').textContent).toMatch(/5 MB/)
  })
})

describe('workflow stage 2: Validate', () => {
  beforeEach(() => { clearAccessToken(); setAccessToken('tok-1'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('renders the per-row verdict table with the summary line', () => {
    wrap(<ValidateStage preview={PREVIEW} committing={false} commitResult={null} error={null} onCommit={() => {}} />)
    expect(screen.getByText(/2 row\(s\) previewed/i)).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
  })

  // Ruling 2026-08-10: a held soundbox row names what it collides with, so the
  // operator can judge it here instead of opening the queue to find out what
  // "duplicate" meant.
  it('names the record a duplicate-VPA row collides with', () => {
    wrap(<ValidateStage preview={PREVIEW} committing={false} commitResult={null} error={null} onCommit={() => {}} />)
    expect(screen.getByText(/duplicate of asgn_9/i)).toBeTruthy()
    // Scoped to the parenthesised merchant name in the duplicate note itself,
    // not a bare /Acme/: row 1's own displayName cell is also the literal
    // text "Acme" (PREVIEW reuses that name for the colliding original), so an
    // unanchored substring match would find both and fail on ambiguity rather
    // than proving the note names the collision.
    expect(screen.getByText(/\(Acme\)/)).toBeTruthy()
  })

  it('commits on click', async () => {
    const onCommit = vi.fn()
    wrap(<ValidateStage preview={PREVIEW} committing={false} commitResult={null} error={null} onCommit={onCommit} />)
    await userEvent.click(screen.getByRole('button', { name: /commit/i }))
    expect(onCommit).toHaveBeenCalledOnce()
  })

  it('renders the commit counts once they land, and hides the button', () => {
    wrap(
      <ValidateStage
        preview={PREVIEW}
        committing={false}
        commitResult={{ accepted: 1, quarantined: 1, duplicate: 0, qrMalformed: 0, duplicateVpa: 1, duplicateVpaHeld: [{ rowNo: 2, duplicateOf: { kind: 'assignment', reference: 'asgn_9', merchantDisplayName: 'Acme' } }], duplicateMobile: 0, fileId: 'f' }}
        error={null}
        onCommit={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull()
    expect(screen.getByText(/accepted/i)).toBeTruthy()
  })

  it('renders whole-file structural errors and no table at all', () => {
    wrap(
      <ValidateStage
        preview={{ rows: [], summary: { total: 0, valid: 0, invalid: 0 }, structuralErrors: [{ code: 'missing_required_column', message: 'Missing column: Mobile' }] }}
        committing={false} commitResult={null} error={null} onCommit={() => {}}
      />,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/missing column/i)
    expect(screen.queryByRole('table')).toBeNull()
  })
})
