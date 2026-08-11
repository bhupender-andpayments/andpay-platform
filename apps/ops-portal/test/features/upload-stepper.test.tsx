import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { UploadStepper } from '../../src/features/uploads/UploadStepper.js'
import { UPLOAD_KINDS, kindBySlug } from '../../src/features/uploads/uploadKinds.js'

afterEach(() => { cleanup() })

const BANK = kindBySlug('bank')!

describe('UploadStepper: the numbered rail', () => {
  it('renders every step for the kind, in order, with its number', () => {
    render(<UploadStepper steps={BANK.steps} current="upload" unlocked={['choose', 'upload']} onStepClick={() => {}} />)
    const labels = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(labels.join(' ')).toMatch(/1.*Choose file.*2.*Upload.*3.*Review.*4.*Commit/s)
  })

  it('an unlocked, non-current step is a clickable button; a locked one is not', () => {
    const onClick = vi.fn()
    render(<UploadStepper steps={BANK.steps} current="upload" unlocked={['choose', 'upload']} onStepClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /choose file/i }))
    expect(onClick).toHaveBeenCalledWith('choose')
    // Review is not unlocked yet: it must not be a button at all.
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()
  })

  it('marks the current step for assistive tech', () => {
    render(<UploadStepper steps={BANK.steps} current="review" unlocked={['choose', 'upload', 'review']} onStepClick={() => {}} />)
    expect(screen.getByText(/review/i).closest('[aria-current]')).toBeTruthy()
  })
})

describe('uploadKinds: the step honesty rules', () => {
  it('device inventory has NO review step and ends in Submit', () => {
    const steps = kindBySlug('device-inventory')!.steps.map((s) => s.key)
    expect(steps).toEqual(['choose', 'upload', 'submit'])
  })

  it('bank and damage end in Commit', () => {
    for (const slug of ['bank', 'damage']) {
      expect(kindBySlug(slug)!.steps.map((s) => s.key)).toEqual(['choose', 'upload', 'review', 'commit'])
    }
  })

  it('states columns ONLY for device inventory', () => {
    for (const kind of UPLOAD_KINDS) {
      if (kind.slug === 'device-inventory') expect(kind.columns).toBeDefined()
      else expect(kind.columns).toBeUndefined()
    }
  })
})
