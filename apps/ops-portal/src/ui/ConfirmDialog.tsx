import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button, ErrorNote } from './primitives.js'

// THE shared "are you sure?" for the whole portal. Every irreversible action
// asks the same way, in the same place on screen, with the same two buttons in
// the same order, so an operator never has to read a new dialog to find out
// which button is the safe one.
//
// It knows nothing about batches, devices or dispatches on purpose: what makes
// this reusable is that the caller supplies the words and, through `children`,
// anything the decision needs (a required reason field, a summary of exactly
// what is about to be locked in). Callers that need more than a sentence put it
// in `children` rather than growing this component a new prop.
//
// The confirm button is never the auto-focused element and the overlay does not
// dismiss on a stray click, which is radix's own default for a modal Dialog:
// confirming has to be deliberate.

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: ReactNode
  /** One sentence naming the consequence. Skip it when `children` says more. */
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** 'danger' paints the confirm button red for a destructive action. */
  tone?: 'default' | 'danger'
  /** Spins the confirm button and blocks both buttons while the write is in flight. */
  busy?: boolean
  /** Guards the confirm button while the dialog's own inputs are incomplete. */
  confirmDisabled?: boolean
  /**
   * Rendered inside the dialog, pinned to the confirm button, exactly as the
   * inline-error rule requires: an error from the action the dialog triggered
   * must not disappear with the dialog or show up as a toast.
   */
  error?: string | null
  onConfirm(): void
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  confirmDisabled = false,
  error = null,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A write in flight must not be dismissed out from under itself: the
        // request is already gone and closing here would leave the operator
        // with no idea whether it landed.
        if (busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {children}

        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={confirmDisabled}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
