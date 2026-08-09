import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Select, Field } from '../../src/ui/primitives.js'

// C-5 (b): the Select TRIGGER must match the Input, per design spec 4.6
// ("Select trigger: same fill treatment as Input, rounded-3xl bg-input/50 h-9").
//
// It did not, and the mismatch was visible in the browser: measured on Reports,
// the select had a 10px radius and an opaque white fill sitting in the same
// toolbar as an Input with a 22px radius and a translucent bg-input/50. Two
// controls, side by side, visibly different shapes.
//
// jsdom computes no layout, so a WIDTH or an overlap can never be caught here;
// those were measured in a real browser. What jsdom CAN pin is the class
// contract, which is what actually regressed, so that is what this guards.

afterEach(() => {
  cleanup()
})

describe('Select primitive (spec 4.6 trigger)', () => {
  it('carries the Input fill treatment: rounded-3xl and bg-input/50', () => {
    render(
      <Select aria-label="pick">
        <option value="a">A</option>
      </Select>,
    )
    const cls = screen.getByLabelText('pick').className
    expect(cls).toContain('rounded-3xl')
    expect(cls).toContain('bg-input/50')
  })

  it('does NOT carry the old shape it drifted to', () => {
    // Pinning the absence too: a straight revert would otherwise pass the
    // check above only until someone re-added rounded-lg alongside it.
    render(
      <Select aria-label="pick">
        <option value="a">A</option>
      </Select>,
    )
    const cls = screen.getByLabelText('pick').className
    expect(cls).not.toContain('rounded-lg')
    expect(cls).not.toContain('bg-background')
  })

  it('still forwards a caller className, so a screen can size its own control', () => {
    render(
      <Select aria-label="pick" className="custom-x">
        <option value="a">A</option>
      </Select>,
    )
    expect(screen.getByLabelText('pick').className).toContain('custom-x')
  })

  it('Field forwards className, which is where a WIDTH belongs', () => {
    // The width goes on the Field, not the control: this container is a fixed
    // 6-column grid, and a wider control simply overflows its own track and
    // lands on top of the next one. Measured at a 17px overlap in the browser
    // before the fix.
    const { container } = render(
      <Field label="Report" className="lg:col-span-2">
        <Select aria-label="pick">
          <option value="a">A</option>
        </Select>
      </Field>,
    )
    expect(container.firstElementChild?.className).toContain('lg:col-span-2')
  })
})
