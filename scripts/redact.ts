/**
 * Redaction for the JSON-RPC log excerpt (`scripts/export-tool-log.ts`).
 *
 * Its own module, with no imports, so it can be unit-tested without dragging in `config.ts` (which
 * exits the process on missing env) or opening a database pool. What this function does is a
 * privacy guarantee on a file we hand to judges, so it is worth a test rather than a read-through.
 */

/**
 * Argument keys that carry the account holder's identity rather than anything about the grocery
 * order. Requests are stored verbatim, which is right for an audit log in our own database and
 * wrong for a published artefact: `silpo_find_address` arguments are literally a home address, and
 * `silpo_create_shopping_cart` carries its coordinates.
 *
 * An explicit list rather than a pattern like /name/: `products: ['куряче філе']` and product names
 * are the substance of the transcript, and a broad rule would blank exactly the parts that
 * demonstrate the integration works. `city` is deliberately kept — «Київ» alone identifies nobody
 * and it makes the branch/slot choice readable.
 */
export const PERSONAL_ARG_KEYS = new Set(
  [
    'address',
    'addressName',
    'street',
    // `house` and `houseNumber` are both real: silpo_create_shopping_cart uses the short form, and
    // a house number next to an unredacted `city` is most of an address.
    'house',
    'houseNumber',
    'building',
    'block',
    'flat',
    'apartment',
    'entrance',
    'floor',
    'phone',
    'phoneNumber',
    'email',
    'firstName',
    'lastName',
    'middleName',
    'recipient',
    'recipientName',
    'comment',
    'latitude',
    'longitude',
    'lat',
    'lng',
    'lon',
  ].map((k) => k.toLowerCase()),
);

export const REDACTED = '«redacted»';

/** Deep-copies `value`, replacing any personal key's value with REDACTED at every nesting depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) =>
        PERSONAL_ARG_KEYS.has(key.toLowerCase()) ? [key, REDACTED] : [key, redact(v)],
      ),
    );
  }
  return value;
}
