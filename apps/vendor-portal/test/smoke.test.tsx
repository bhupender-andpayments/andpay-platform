import { it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { App } from '../src/App.js'

// App now supplies its own BrowserRouter (spec 14b task 15), so this test no
// longer wraps it in a MemoryRouter: nesting a second Router would throw.
it('renders the vendor portal shell', () => {
  const { getByText } = render(<App />)
  expect(getByText('AndPayments Vendor')).toBeTruthy()
})
