import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog } from '../../src/ui/ConfirmDialog.js'

// The portal's one "are you sure?", so every irreversible action asks the same
// way. What is under test is the contract its callers depend on: the confirm
// button is guarded, the dismiss paths report themselves, an error stays inside
// the dialog, and a write in flight cannot be dismissed out from under itself.

function open(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Create this batch?"
      description="This cannot be undone."
      confirmLabel="Create batch"
      onConfirm={onConfirm}
      {...over}
    />,
  )
  return { onConfirm, onOpenChange }
}

describe('ConfirmDialog', () => {
  afterEach(() => cleanup())

  it('names the action and its consequence', () => {
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Create this batch?')).toBeTruthy()
    expect(screen.getByText('This cannot be undone.')).toBeTruthy()
  })

  it('confirms through the caller, once', async () => {
    const { onConfirm } = open()
    await userEvent.click(screen.getByRole('button', { name: /create batch/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('reports a cancel as a close, so the caller can clear its own state', async () => {
    const { onOpenChange, onConfirm } = open()
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('guards the confirm button while the caller says the decision is incomplete', () => {
    open({ confirmDisabled: true })
    expect((screen.getByRole('button', { name: /create batch/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders extra content, which is how a required field reaches the decision', () => {
    open({ children: <label htmlFor="why">Reason</label> })
    expect(screen.getByText('Reason')).toBeTruthy()
  })

  it('keeps an error inside the dialog rather than letting it vanish with it', () => {
    open({ error: 'The edge refused it.' })
    expect(screen.getByRole('alert').textContent).toContain('The edge refused it.')
  })

  // The request is already gone by then, and closing would leave the operator
  // with no idea whether it landed.
  it('cannot be dismissed while the write it started is in flight', async () => {
    const { onOpenChange } = open({ busy: true })
    const cancel = screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
