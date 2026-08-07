// Trigger a browser download for an in-memory blob. Extracted from
// features/operations/BatchPage.tsx when the P2-3 batch detail hub needed the
// same behaviour: it must NOT be exported from a module that also exports a
// React component, because a mixed export breaks react-refresh ("Could not
// Fast Refresh"), which invalidates the module on every edit.
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
