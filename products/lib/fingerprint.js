// Gives every offer without a real barcode a stable identity anyway, so it
// can still be upserted/deduped like a gtin'd product instead of being
// treated as un-trackable. Each chain decides *which* fields are safe to
// build that identity from (excluding anything that changes without the
// product itself changing, like validUntil rolling over every campaign
// week) - this just turns that already-filtered field set into one
// consistent string, so that mechanical step isn't copy-pasted per chain.
export function buildFingerprint(identityFields) {
  return Object.values(identityFields)
    .map((v) => (v === null || v === undefined ? "NULL" : String(v).toUpperCase().replace(/\s/g, "")))
    .join("");
}
