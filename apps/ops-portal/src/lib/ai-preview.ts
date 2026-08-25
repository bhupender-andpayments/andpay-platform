// Client-side rasterization of a .ai logo master. Adobe Illustrator files
// saved with PDF compatibility (the default since Illustrator 9) are valid
// PDFs, so pdf.js can draw page 1 onto a canvas entirely in the browser. That
// gives the operator an instant preview of the artwork they picked AND
// auto-generates the PNG render derivative the upload pair requires, while
// preserving the spec ruling that the SERVER never rasterizes (the pair is
// still uploaded as master plus derivative; only where the derivative is made
// changed, from the operator's desktop tooling to their browser).
//
// A .ai saved WITHOUT PDF compatibility is a plain PostScript stream pdf.js
// cannot parse; this then rejects and the caller falls back to asking for a
// manually exported PNG or SVG, exactly the pre-existing flow.
export interface AiPreview {
  pngBlob: Blob
  dataUrl: string
}

// Longest edge of the generated derivative, matching the 1600px the bulk
// import used (qlmanage -s 1600), so browser-made and script-made derivatives
// come out at comparable fidelity.
const MAX_EDGE_PX = 1600

export async function rasterizeAiFile(file: File): Promise<AiPreview> {
  // Dynamic import: pdf.js is heavy and only needed once an operator actually
  // picks a .ai file, and a static import would drag it into every jsdom test
  // that merely renders the dialog.
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
  // No isEvalSupported here: pdf.js removed that option in v6 because the
  // eval-based font path is gone, so there is nothing to switch off and the
  // portal CSP's lack of 'unsafe-eval' is already satisfied. Passing it was a
  // type error the portal's own build caught.
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const doc = await loadingTask.promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(4, MAX_EDGE_PX / Math.max(base.width, base.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const canvasContext = canvas.getContext('2d')
    if (canvasContext === null) throw new Error('This browser refused a 2d canvas context.')
    await page.render({ canvasContext, viewport, canvas }).promise
    const dataUrl = canvas.toDataURL('image/png')
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b !== null ? resolve(b) : reject(new Error('canvas.toBlob returned null.'))), 'image/png')
    })
    return { pngBlob, dataUrl }
  } finally {
    // pdf.js v6: teardown is the loading task's, not the document proxy's.
    await loadingTask.destroy()
  }
}

/** The auto-generated derivative File for an .ai master: same basename, .png. */
export function derivativeFileFor(masterName: string, pngBlob: Blob): File {
  const base = masterName.replace(/\.[^.]+$/, '')
  return new File([pngBlob], `${base}.png`, { type: 'image/png' })
}
