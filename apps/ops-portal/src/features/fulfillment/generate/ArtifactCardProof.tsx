// The card, on screen, as STORED.
//
// This replaced a client-side lookalike (ruled 21 Aug 2026: wherever bank data
// appears it points at master bank data, backend plus the asset store). The
// old proof re-drew the card in the browser from a static GSCB plate shipped
// in public/, which meant every aggregator proofed on one bank's artwork while
// the server's stored artifact carried the aggregator's own logo. Now the
// proof fetches the composed artifact itself and rasterizes page 1 with the
// same pdf.js path the .ai logo preview uses, so the pixels the operator
// checks are the pixels the print vendor receives. Nothing here knows about
// plates, geometry, or fonts; there is nothing left to drift.
import { useEffect, useState } from 'react'
import { fetchDispatchArtifact } from '../../../api/endpoints.js'
import { useAuth } from '../../../auth/AuthContext.js'
import { rasterizeAiFile } from '../../../lib/ai-preview.js'

type ProofState =
  | { kind: 'loading' }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'missing' }
  | { kind: 'undrawable'; url: string }
  | { kind: 'error' }

export function ArtifactCardProof({
  btchId,
  asgnId,
  artifactType,
  className,
}: {
  btchId: string
  asgnId: string
  artifactType: string
  className?: string
}) {
  const { client } = useAuth()
  const [state, setState] = useState<ProofState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setState({ kind: 'loading' })
    fetchDispatchArtifact(client, btchId, asgnId, artifactType)
      .then(async (blob) => {
        if (blob === null) {
          if (!cancelled) setState({ kind: 'missing' })
          return
        }
        try {
          // The stored artifact is a PDF; the .ai rasterizer parses any
          // PDF-compatible bytes, so it serves both previews from one path.
          const { dataUrl } = await rasterizeAiFile(new File([blob], `${asgnId}.pdf`, { type: 'application/pdf' }))
          if (!cancelled) setState({ kind: 'image', dataUrl })
        } catch {
          // Cannot draw here (an exotic PDF, or a canvas-less environment):
          // the artifact still exists, so hand it over as a tab instead of a
          // dead end. blob: is fine as a NAVIGATION target; only img-src
          // blocks it.
          objectUrl = URL.createObjectURL(blob)
          if (!cancelled) setState({ kind: 'undrawable', url: objectUrl })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [client, btchId, asgnId, artifactType])

  if (state.kind === 'loading') return <p className="p-3 text-sm text-muted-foreground">Loading the stored card…</p>
  if (state.kind === 'missing') {
    return <p className="p-3 text-sm text-muted-foreground">No stored card of this type for this dispatch yet.</p>
  }
  if (state.kind === 'error') {
    return <p className="p-3 text-sm text-muted-foreground">Could not load the stored card. Try again.</p>
  }
  if (state.kind === 'undrawable') {
    return (
      <p className="p-3 text-sm text-muted-foreground">
        The stored card could not be drawn here.{' '}
        <a className="text-primary underline" href={state.url} target="_blank" rel="noreferrer">
          Open the PDF
        </a>
        .
      </p>
    )
  }
  return (
    <img
      src={state.dataUrl}
      alt="The stored card as it will print"
      className={className === undefined ? 'w-full bg-white object-contain' : `w-full bg-white object-contain ${className}`}
    />
  )
}
