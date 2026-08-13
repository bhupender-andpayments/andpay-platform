import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadPackageButton } from '../../src/features/pull/DownloadPackageButton.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed FR-04 pull contract (task 10, packageDownloadPath), now
// PER DELIVERY GROUP (2026-08-10 ruling: the vendor pull and the vendor portal
// split the same way as the dispatch Excel builder):
//   GET /vendor/batch/:btchId/package/:group -> .xlsx binary (recipient PII
//   inside). Per D104/S7 the SPA must NEVER parse/read that payload; it only
// triggers a browser download. This is a raw fetch (not the JSON api client),
// so it does NOT go through the 401-refresh interceptor by design.

interface Call {
  url: string
  init: RequestInit
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

describe('DownloadPackageButton', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it('on 200: fetches the package with a Bearer header and triggers a browser download without ever reading the blob content', async () => {
    const calls: Call[] = []
    // A fake blob-like object standing in for the real binary payload. Its
    // `text`/`arrayBuffer` methods are spies: the component must never call
    // them, since that would mean the PII-bearing xlsx content was read into
    // JS-land instead of staying opaque cargo for the browser's own download.
    const textSpy = vi.fn(async () => 'ship-to-secret-content')
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0))
    const fakeBlob = { text: textSpy, arrayBuffer: arrayBufferSpy }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return { status: 200, ok: true, blob: async () => fakeBlob }
      }),
    )

    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<DownloadPackageButton btchId="btch_1" group="SOUNDBOX" kind="excel" label="Soundbox Excel" />)

    await userEvent.click(screen.getByRole('button', { name: /download/i }))

    await vi.waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1)
    })

    const call = calls.find((c) => c.url.includes('/vendor/batch/btch_1/package/SOUNDBOX'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Authorization')).toBe('Bearer tok-1')

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    // The blob content must NEVER be read/parsed into the SPA.
    expect(textSpy).not.toHaveBeenCalled()
    expect(arrayBufferSpy).not.toHaveBeenCalled()

    // No PII from the file content ever enters the DOM.
    expect(document.body.textContent).not.toContain('ship-to-secret-content')

    clickSpy.mockRestore()
  })

  it('on 403: shows a denial message and does not create a download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 403, ok: false, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) })),
    )
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

    render(<DownloadPackageButton btchId="btch_2" group="COLLATERAL" kind="excel" label="Collateral Excel" />)

    await userEvent.click(screen.getByRole('button', { name: /download/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/not (allowed|permitted|authorized)/i)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('on 401: shows a session/re-login message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, ok: false, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) })),
    )

    render(<DownloadPackageButton btchId="btch_3" group="SOUNDBOX" kind="excel" label="Soundbox Excel" />)

    await userEvent.click(screen.getByRole('button', { name: /download/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/sign in|session|log in/i)
  })

  // The two-button reality (task 3): the component itself carries no knowledge
  // of its sibling, so proving the split works means rendering both at once,
  // exactly as WorkQueuePage now does, and checking each fetches its OWN
  // group-scoped path under its OWN label.
  it('renders as two independent buttons, one per delivery group, each hitting its own group-scoped path', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return { status: 200, ok: true, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) }
      }),
    )
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(
      <>
        <DownloadPackageButton btchId="btch_4" group="SOUNDBOX" kind="excel" label="Soundbox Excel" />
        <DownloadPackageButton btchId="btch_4" group="COLLATERAL" kind="excel" label="Collateral Excel" />
      </>,
    )

    expect(screen.getByRole('button', { name: /download soundbox excel/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /download collateral excel/i })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /download soundbox excel/i }))
    await userEvent.click(screen.getByRole('button', { name: /download collateral excel/i }))

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2)
    })
    expect(calls.some((c) => c.url.includes('/vendor/batch/btch_4/package/SOUNDBOX'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/vendor/batch/btch_4/package/COLLATERAL'))).toBe(true)

    clickSpy.mockRestore()
  })

  // D-12 (T7.2, Q11 ruled 13 Aug 2026): a dispatch is FOUR files, in two pairs.
  // This portal only ever offered the two Excels while the images route sat live
  // and authorized at the edge with nothing calling it, so half a vendor's
  // package was reachable only by hand-building a URL.
  describe('the images half of each pair (D-12, four files per dispatch)', () => {
    it('kind="images" hits the collateral route, not the package route, and names the file .pdf', async () => {
      const calls: Call[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          return { status: 200, ok: true, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) }
        }),
      )
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
      // The filename is read off the anchor the component builds, because that
      // is what actually lands on the vendor's disk. Mirrors the edge's own
      // Content-Disposition so clicking and curling agree.
      const names: (string | undefined)[] = []
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.getAttribute('download') ?? undefined)
      })

      render(<DownloadPackageButton btchId="btch_5" group="COLLATERAL" kind="images" label="Collateral QR images" />)
      await userEvent.click(screen.getByRole('button', { name: /download collateral qr images/i }))

      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(calls[0]!.url).toContain('/vendor/batch/btch_5/collateral/COLLATERAL')
      expect(calls[0]!.url).not.toContain('/package/')
      expect(headerValue(calls[0]!, 'Authorization')).toBe('Bearer tok-1')
      expect(names).toEqual(['COLLATERAL-btch_5.pdf'])

      clickSpy.mockRestore()
    })

    it('all FOUR buttons hit four distinct paths, which is the shape the ruling names', async () => {
      const calls: Call[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          return { status: 200, ok: true, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) }
        }),
      )
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

      render(
        <>
          <DownloadPackageButton btchId="btch_6" group="SOUNDBOX" kind="excel" label="Soundbox Excel" />
          <DownloadPackageButton btchId="btch_6" group="SOUNDBOX" kind="images" label="Soundbox QR images" />
          <DownloadPackageButton btchId="btch_6" group="COLLATERAL" kind="excel" label="Collateral Excel" />
          <DownloadPackageButton btchId="btch_6" group="COLLATERAL" kind="images" label="Collateral QR images" />
        </>,
      )

      for (const name of [
        /download soundbox excel/i,
        /download soundbox qr images/i,
        /download collateral excel/i,
        /download collateral qr images/i,
      ]) {
        await userEvent.click(screen.getByRole('button', { name }))
      }

      await vi.waitFor(() => {
        expect(calls).toHaveLength(4)
      })
      expect(new Set(calls.map((c) => c.url)).size).toBe(4)
      expect(calls.map((c) => c.url.replace(/^.*\/vendor/, '/vendor')).sort()).toEqual([
        '/vendor/batch/btch_6/collateral/COLLATERAL',
        '/vendor/batch/btch_6/collateral/SOUNDBOX',
        '/vendor/batch/btch_6/package/COLLATERAL',
        '/vendor/batch/btch_6/package/SOUNDBOX',
      ])

      clickSpy.mockRestore()
    })

    it('on 404 says the batch has none, rather than telling the vendor to retry something that cannot succeed', async () => {
      // A soundbox-only batch legitimately has no collateral images, and the
      // edge answers 404 for exactly that. This used to fall into the generic
      // failure branch, whose copy is "Please try again".
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 404, ok: false, blob: async () => ({ text: vi.fn(), arrayBuffer: vi.fn() }) })),
      )
      const createObjectURL = vi.fn(() => 'blob:mock-url')
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

      render(<DownloadPackageButton btchId="btch_7" group="COLLATERAL" kind="images" label="Collateral QR images" />)
      await userEvent.click(screen.getByRole('button', { name: /download/i }))

      const note = await screen.findByRole('status')
      expect(note.textContent).toMatch(/no collateral qr images/i)
      expect(note.textContent).not.toMatch(/try again/i)
      // Not an error, so nothing shouts at the vendor and no download starts.
      expect(screen.queryByRole('alert')).toBeNull()
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('never reads the images blob either, same opaque-cargo rule as the PII-bearing Excel', async () => {
      const textSpy = vi.fn(async () => 'pdf-bytes')
      const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0))
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 200, ok: true, blob: async () => ({ text: textSpy, arrayBuffer: arrayBufferSpy }) })),
      )
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

      render(<DownloadPackageButton btchId="btch_8" group="SOUNDBOX" kind="images" label="Soundbox QR images" />)
      await userEvent.click(screen.getByRole('button', { name: /download/i }))

      await vi.waitFor(() => {
        expect(clickSpy).toHaveBeenCalledTimes(1)
      })
      expect(textSpy).not.toHaveBeenCalled()
      expect(arrayBufferSpy).not.toHaveBeenCalled()

      clickSpy.mockRestore()
    })
  })
})
