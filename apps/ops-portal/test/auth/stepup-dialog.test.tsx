import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StepUpDialog } from '../../src/auth/StepUpDialog.js'
import { promptStepUpTotp } from '../../src/auth/stepUpController.js'

// Task 8 (check 2): the imperative promptStepUpTotp() bridged to a React
// modal via the stepUpController singleton (Task 6's api client already
// awaits deps.promptStepUpTotp() from outside any component). These tests
// exercise the controller + dialog directly, the same way the interceptor
// does, without needing a live 403 round trip.
describe('step-up TOTP dialog', () => {
  afterEach(() => { cleanup() })

  it('calling promptStepUpTotp() renders the modal with a labelled TOTP field', async () => {
    render(<StepUpDialog />)
    expect(screen.queryByLabelText(/totp/i)).toBeNull()

    void promptStepUpTotp()

    expect(await screen.findByLabelText(/totp/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /confirm/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('typing a code and clicking Confirm resolves the promise with that code', async () => {
    render(<StepUpDialog />)
    const promise = promptStepUpTotp()

    const input = await screen.findByLabelText(/totp/i)
    await userEvent.type(input, '123456')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    await expect(promise).resolves.toBe('123456')
  })

  it('clicking Cancel resolves with null', async () => {
    render(<StepUpDialog />)
    const promise = promptStepUpTotp()

    await screen.findByLabelText(/totp/i)
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await expect(promise).resolves.toBeNull()
  })

  it('after resolving, the code is not retained: re-opening shows an empty field', async () => {
    render(<StepUpDialog />)
    const first = promptStepUpTotp()

    const input = await screen.findByLabelText(/totp/i)
    await userEvent.type(input, '999999')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(await first).toBe('999999')

    // dialog closes after resolving
    expect(screen.queryByLabelText(/totp/i)).toBeNull()

    const second = promptStepUpTotp()
    const reopened = await screen.findByLabelText(/totp/i)
    expect((reopened as HTMLInputElement).value).toBe('')
    // the previous code must not resurface anywhere in the reopened dialog
    expect(screen.queryByText('999999')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(await second).toBeNull()
  })

  it('a second promptStepUpTotp() call while one is pending resolves the stale one with null', async () => {
    render(<StepUpDialog />)
    const first = promptStepUpTotp()
    await screen.findByLabelText(/totp/i)

    const second = promptStepUpTotp()
    expect(await first).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(await second).toBeNull()
  })
})
