import { useEffect, useState } from 'react'

// The form plumbing the four master-data create dialogs share (2026-08-17).
//
// Extracted rather than copied FOUR times: every one of them needs the same
// reset-on-open, the same string-keyed field bag, the same saving flag and the
// same "show the server's message inline instead of a toast" failure path. The
// merchant dialog (features/merchants/MerchantCreateDialog.tsx) predates this
// and still carries its own copy; it is deliberately left alone rather than
// refactored as a passenger of this task.
//
// Field values are STRINGS throughout, including numeric ones. A number input
// still yields a string, and an empty numeric field must be distinguishable
// from a zero, which `Number('')` is not. Each dialog converts at the edge,
// where it also validates.
export function useCreateDialog(open: boolean) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset on every open so an abandoned draft never pre-fills the next one.
  useEffect(() => {
    if (!open) return
    setForm({})
    setError(null)
  }, [open])

  const f = (key: string): string => form[key] ?? ''

  const set = (key: string) => (e: { target: { value: string } }) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }))
  }

  const setValue = (key: string, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const filled = (...keys: string[]): boolean => keys.every((k) => f(k).trim() !== '')

  /**
   * Run one save. The server's own message is surfaced inline, because these
   * are the errors an operator can act on: a duplicate courier code, a bank
   * reference that already exists, a batching tier the domain refuses.
   */
  async function save(run: () => Promise<void>, fallback: string): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await run()
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
    } finally {
      setSaving(false)
    }
  }

  return { f, set, setValue, filled, saving, error, save }
}
