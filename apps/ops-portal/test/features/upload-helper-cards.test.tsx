import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { UploadHelperCards } from '../../src/features/uploads/UploadHelperCards.js'
import { kindBySlug } from '../../src/features/uploads/uploadKinds.js'

afterEach(() => { cleanup() })

// The damage kind that used to drive these tests is gone (D-25: no damage
// file ingestion). The bank kind exercises the same shape: a four-step
// choose/upload/review/commit flow whose good-to-know states no column list.
const BANK = kindBySlug('bank')!
const DEVICE_INVENTORY = kindBySlug('device-inventory')!

// Spec section 8 names "Helper copy changes with the step" as required
// coverage. Plain component test, no router or auth needed, following
// upload-stepper.test.tsx's shape: UploadHelperCards takes a kind and a step
// and renders straight off uploadKinds.ts data.
describe('UploadHelperCards: the copy changes with the step', () => {
  it('the What happens next copy DIFFERS between two steps of the same kind', () => {
    const { unmount } = render(<UploadHelperCards kind={BANK} step="upload" />)
    const uploadText = screen.getByText(/what happens next/i).closest('div')!.textContent
    unmount()

    render(<UploadHelperCards kind={BANK} step="review" />)
    const reviewText = screen.getByText(/what happens next/i).closest('div')!.textContent

    // This is the whole reason the card re-renders per step: a regression
    // pinning nextByStep to one step (or reusing the same array reference for
    // every step) must fail this assertion.
    expect(uploadText).not.toEqual(reviewText)
  })

  it('a step with no nextByStep entry renders only the Good to know card', () => {
    // 'choose' has no nextByStep entry for any kind.
    render(<UploadHelperCards kind={BANK} step="choose" />)
    expect(screen.queryByText(/what happens next/i)).toBeNull()
    expect(screen.getByText(/good to know/i)).toBeTruthy()
  })

  it('the Good to know copy for bank contains NO column list, while device inventory\'s does', () => {
    const { unmount: unmountBank } = render(<UploadHelperCards kind={BANK} step="upload" />)
    const bankGoodToKnow = screen.getByText(/good to know/i).closest('div')!.textContent!
    expect(bankGoodToKnow).not.toMatch(/required columns/i)
    unmountBank()

    render(<UploadHelperCards kind={DEVICE_INVENTORY} step="upload" />)
    const deviceGoodToKnow = screen.getByText(/good to know/i).closest('div')!.textContent!
    expect(deviceGoodToKnow).toMatch(/required columns/i)
  })
})
