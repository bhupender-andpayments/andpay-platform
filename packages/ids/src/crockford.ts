/**
 * Crockford Base32 over a fixed 128 bit payload, lowercase, no padding.
 *
 * The 128 bits are encoded most significant bit first into 26 characters
 * (26 * 5 = 130 bits, so two leading zero pad bits). Encoding MSB first with an
 * alphabet whose characters are in ascending ASCII order makes the encoding
 * order preserving: a larger 128 bit value yields a lexicographically larger
 * string. That is what gives ids their k-sortability (I3, spec 4).
 *
 * The alphabet excludes I, L, O and U (Crockford). This module uses the
 * lowercase form only; uppercase and the excluded letters are rejected on
 * decode.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

const CHAR_TO_VALUE = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_TO_VALUE.set(ALPHABET.charAt(i), i)
}

/** Fixed number of Crockford Base32 characters that encode 128 bits. */
export const PAYLOAD_LENGTH = 26

/** Largest value representable in 128 bits, plus one. */
export const TWO_POW_128 = 1n << 128n

/** Encode a 128 bit non-negative integer as a 26 character lowercase payload. */
export function encode128(value: bigint): string {
  let out = ''
  for (let shift = 125; shift >= 0; shift -= 5) {
    const index = Number((value >> BigInt(shift)) & 0x1fn)
    out += ALPHABET.charAt(index)
  }
  return out
}

/**
 * Decode a payload back to its integer value. Returns null when any character
 * is outside the lowercase Crockford alphabet. The returned value may exceed
 * 128 bits (the two pad bits are not validated here); callers that require a
 * strict 128 bit value must compare against TWO_POW_128.
 */
export function tryDecode128(payload: string): bigint | null {
  let value = 0n
  for (const ch of payload) {
    const digit = CHAR_TO_VALUE.get(ch)
    if (digit === undefined) return null
    value = (value << 5n) | BigInt(digit)
  }
  return value
}
