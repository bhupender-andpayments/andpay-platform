import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from '../src/App.js'

describe('ops-portal smoke', () => {
  it('renders the app shell', () => {
    render(<App />)
    expect(screen.getByText(/AndPayments Ops/i)).toBeTruthy()
  })
})
