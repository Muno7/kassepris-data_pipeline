// Every chain prints prices as Swedish-formatted strings meant for a human
// ("48,17-52,90", "79,90 kr", "66,90/st") - this is the one place that turns
// that text into an integer öre amount everyone downstream can do math on,
// so the parsing rules (comma decimals, range-as-lower-bound) only need to
// be right in one place instead of independently in every fetch.js.
export function parsePriceToCents(str) {
  if (!str) return null;
  // A range ("48,17-52,90") reports its lower bound - a consistent,
  // documented approximation rather than each chain guessing differently.
  const firstOfRange = str.split(/[-–]/)[0];
  const match = firstOfRange.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(",", "."));
  return Number.isFinite(val) ? Math.round(val * 100) : null;
}
