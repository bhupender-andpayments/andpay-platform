// The bank-supplied UPI QR payload: its one known defect, detected and corrected.
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
// WHY THIS IS A SHARED PACKAGE AND NOT A SERVICE MODULE. Two contexts need the
// SAME rule for two DIFFERENT purposes, and neither may import the other's
// source (C4):
//
//   TMS DETECTS. It reports how many rows of a bank file carry the defect, which
//     is the evidence the D4 ruling asks for (see below). Detecting is not
//     altering, so this does not breach D117/T2: TMS still stores and emits the
//     bank string VERBATIM and the fact stream keeps a faithful record of what
//     GSCB actually sent.
//   FULFILLMENT CORRECTS. At the point the value becomes something a merchant or
//     a vendor scans or prints. There are two such boundaries and BOTH call
//     decodeBankQrPayload:
//       1. collateral/renderer.ts  the QR PNG encoded onto the printed artifact
//       2. package.ts              `labelQr`, the QR column on the vendor sheet
//
// One regex, one home. Two copies of a rule this subtle is how a detector starts
// reporting a count that does not match what the corrector actually rewrites.
//
// THE D4 RULING (docs/plan/BANK_FILE_DECISIONS_2026-08-07.md) ends: "This is a
// compensating control for a bank-side bug, not a fix. GSCB should still be
// told." hasEncodedSeparator is what produces the number to tell them, per FILE,
// which is the grain that conversation needs. Without it the correction is
// silent, and if GSCB ever fix their export (or regress) nobody would learn it.

// Matches `&amp;` ONLY where it is acting as a query separator, that is where a
// parameter name and its `=` follow immediately. Deliberately narrow: a
// merchant legitimately named "SHAH & SONS" arriving as `pn=SHAH &amp; SONS`
// is NOT rewritten, because " SONS" does not match a `name=` token. A blanket
// replace would corrupt that merchant's printed name.
//
// NOT a module-level /g regex shared between the two functions below. A /g
// regex carries mutable `lastIndex`, so a `test()` and a `replace()` sharing one
// instance can make each other skip matches depending on call order. Each call
// builds its own.
function separatorPattern(): RegExp {
  return /&amp;(?=[A-Za-z0-9_.-]+=)/g
}

/**
 * True when the payload carries at least one HTML-escaped query separator, so
 * callers can surface that a bank file needed correcting instead of letting it
 * become folklore.
 *
 * Exactly the condition decodeBankQrPayload would rewrite, so a count of these
 * is a count of what the correction actually changes.
 */
export function hasEncodedSeparator(raw: string): boolean {
  return separatorPattern().test(raw)
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
  return raw.replace(separatorPattern(), '&')
}
