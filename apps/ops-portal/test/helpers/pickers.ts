import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Drives the common SearchSelect (components/Picker.tsx) the way an operator
// does: click the trigger, then click the option inside the popover's own
// listbox. Scoped to the listbox because the grid's rows-per-page select also
// exposes option roles.
//
// `trigger` matches the trigger's visible summary text: the placeholder when
// nothing is picked, the selected label afterwards.
export async function pickOption(trigger: RegExp | string, option: RegExp | string): Promise<void> {
  const triggers = screen.getAllByText(trigger)
  await userEvent.click(triggers[0]!)
  const listbox = await screen.findByRole('listbox')
  await userEvent.click(within(listbox).getByRole('option', { name: option }))
}

/** The options currently offered by an open SearchSelect, as their labels. */
export async function openAndListOptions(trigger: RegExp | string): Promise<string[]> {
  const triggers = screen.getAllByText(trigger)
  await userEvent.click(triggers[0]!)
  const listbox = await screen.findByRole('listbox')
  return within(listbox)
    .getAllByRole('option')
    .map((o) => o.textContent?.trim() ?? '')
}
