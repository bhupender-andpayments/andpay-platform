import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { UploadStepper } from '../../src/features/uploads/UploadStepper.js'
import { UPLOAD_KINDS, kindBySlug } from '../../src/features/uploads/uploadKinds.js'

afterEach(() => { cleanup() })

const DAMAGE = kindBySlug('damage')!

describe('UploadStepper: the numbered rail', () => {
  it('renders every step for the kind, in order, with its number', () => {
    render(<UploadStepper steps={DAMAGE.steps} current="upload" unlocked={['choose', 'upload']} onStepClick={() => {}} />)
    const labels = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(labels.join(' ')).toMatch(/1.*Choose file.*2.*Upload.*3.*Review.*4.*Commit/s)
  })

  it('an unlocked, non-current step is a clickable button; a locked one is not', () => {
    const onClick = vi.fn()
    render(<UploadStepper steps={DAMAGE.steps} current="upload" unlocked={['choose', 'upload']} onStepClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /choose file/i }))
    expect(onClick).toHaveBeenCalledWith('choose')
    // Review is not unlocked yet: it must not be a button at all.
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()
  })

  it('marks the current step for assistive tech', () => {
    render(<UploadStepper steps={DAMAGE.steps} current="review" unlocked={['choose', 'upload', 'review']} onStepClick={() => {}} />)
    expect(screen.getByText(/review/i).closest('[aria-current]')).toBeTruthy()
  })
})

describe('uploadKinds: the step honesty rules', () => {
  it('device inventory has NO review step and ends in Submit', () => {
    const steps = kindBySlug('device-inventory')!.steps.map((s) => s.key)
    expect(steps).toEqual(['choose', 'upload', 'submit'])
  })

  it('damage ends in Commit', () => {
    for (const slug of ['damage']) {
      expect(kindBySlug(slug)!.steps.map((s) => s.key)).toEqual(['choose', 'upload', 'review', 'commit'])
    }
  })

  it('courier status has NO review step and ends in Submit', () => {
    expect(kindBySlug('courier-status')!.steps.map((s) => s.key)).toEqual(['choose', 'upload', 'submit'])
  })

  // The rule is NOT "device inventory is special", it is "state columns only
  // where the portal shares a real constant with the parser". Device inventory
  // and courier status both do; bank and damage resolve their layout by source
  // profile at ingest, so listing columns for those would invent a contract the
  // portal cannot check.
  it('states columns ONLY where the portal shares a real constant with the parser', () => {
    const withColumns = UPLOAD_KINDS.filter((k) => k.columns !== undefined).map((k) => k.slug)
    expect(withColumns.sort()).toEqual(['courier-status', 'device-inventory'])
  })
})
