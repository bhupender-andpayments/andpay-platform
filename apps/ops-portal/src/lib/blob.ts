// The portal CSP is img-src 'self' data:, which blocks a blob: URL (Chrome
// reports "violates the following Content Security Policy directive"), so any
// fetched or locally picked image Blob is read into a data: URL before it can
// feed an <img>. No revoke is needed: a data: URL holds no browser resource
// the way an object URL does. One shared copy; the masterdata dialogs and the
// list thumbnail all import this rather than growing their own.
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the image blob.'))
    reader.readAsDataURL(blob)
  })
}
