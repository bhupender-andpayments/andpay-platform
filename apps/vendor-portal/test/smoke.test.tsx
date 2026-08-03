import { it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App.js'

it('renders the vendor portal shell', () => {
  const { getByText } = render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  )
  expect(getByText('AndPayments Vendor')).toBeTruthy()
})
