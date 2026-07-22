// Validates a 13-digit GTIN/EAN by its GS1 check digit - the last digit is
// derived from the first 12 via alternating x1/x3 weights, so a string that
// merely looks like a barcode (right length, all digits) only passes this
// by chance 1 time in 10. That's what makes it useful as a filter for
// numbers recovered from somewhere that isn't a labeled gtin field - see
// products/willys/fetch.js's extractGtinFromImageUrl for the motivating case.
export function isValidGtin13(digits) {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(12) - 48;
}
