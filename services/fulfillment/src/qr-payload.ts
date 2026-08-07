// The bank-supplied UPI QR payload, corrected at the ARTIFACT boundary.
//
// THE DEFECT. GSCB's export HTML-escapes exactly the FIRST query separator in
// every UPI payload it ships. All 360 rows of the 2026-05-14 sample arrive as:
//
//   upi://pay?ver=01&amp;mode=01&pa=<vpa>&pn=<name>&mc=<mcc>&qrMedium=06
//                  ^^^^^                 the remaining five separators are bare
//
// A scanner splits the query on '&', so it reads the second parameter as
// `amp;mode=01`: the `mode` parameter is LOST and a junk parameter takes its
// place. `pa`, `pn` and `mc` survive, which is why payment usually still
// resolves, but the payload is malformed and a stricter UPI app is entitled to
// reject it. It is printed onto standees and stickers that cannot be recalled,
// so it is worth correcting rather than shipping.
//
// WHY THE FIX LIVES HERE AND NOT AT INGEST. services/tms/src/internal.ts states
// the D117/T2 constraint plainly: TMS validates FORMAT only and never mints,
// derives, or alters the value. So TMS stores and emits the bank string
// VERBATIM, and the fact stream keeps a faithful record of what GSCB actually
// sent. Correction happens at the point where the value becomes something a
// merchant or a vendor scans or prints, which is fulfillment's job. There are
// two such points and BOTH call this:
//
//   1. collateral/renderer.ts  the QR PNG encoded onto the printed artifact
//   2. package.ts              `labelQr`, the QR column on the vendor dispatch sheet
//
// This is a compensating control for a bank-side bug, not a fix. The real fix
// is GSCB correcting their export, at which point this becomes a silent no-op.
//
// See also the pointer at services/tms/src/bank-file-adapter.ts, on the column
// mapping that carries the raw value in.

// Matches `&amp;` ONLY where it is acting as a query separator, that is where a
// parameter name and its `=` follow immediately. Deliberately narrow: a
// merchant legitimately named "SHAH & SONS" arriving as `pn=SHAH &amp; SONS`
// is NOT rewritten, because " SONS" does not match a `name=` token. A blanket
// replace would corrupt that merchant's printed name.
const ENCODED_SEPARATOR = /&amp;(?=[A-Za-z0-9_.-]+=)/g

/**
 * True when the payload carries at least one HTML-escaped query separator, so
 * callers can surface that a bank file needed correcting instead of letting it
 * become folklore.
 */
export function hasEncodedSeparator(raw: string): boolean {
  ENCODED_SEPARATOR.lastIndex = 0
  return ENCODED_SEPARATOR.test(raw)
}

/**
 * Decode HTML-escaped query separators in a bank-supplied UPI payload, so what
 * gets scanned or printed parses into the parameters the bank intended.
 *
 * Conservative by design. A doubly-escaped `&amp;amp;mode=01` is left ALONE
 * rather than half-decoded, because `amp;mode` is not a parameter-name token
 * and the lookahead refuses it. Input mangled beyond confident recognition
 * passes through untouched instead of being guessed at.
 */
export function decodeBankQrPayload(raw: string): string {
  return raw.replace(ENCODED_SEPARATOR, '&')
}
