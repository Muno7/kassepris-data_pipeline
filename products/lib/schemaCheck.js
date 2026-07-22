// Detects when an upstream API's response shape drifts from what we last
// saw - e.g. Coop renaming priceInformation.discountValue would otherwise
// fail silently (we'd just start writing null prices, no error anywhere).
// Works by reducing a sample response to a sorted list of "path:type" pairs
// and diffing that against a persisted baseline.
//
// Arrays are unioned across up to MAX_ARRAY_SAMPLE elements rather than
// just the first - fields like Coop's clusterInteriorOffers only appear on
// some offers (multi-SKU campaigns), not all, so sampling a single element
// made the fingerprint depend on which offer happened to be first, producing
// false "schema changed" noise on every run rather than catching real API
// drift. This is a real reduction, not a full fix - a field that's sparse
// enough to be absent from every sampled element in a given run (e.g. zero
// clustered offers that particular week) can still register as a spurious
// removal; treat isolated single-field diffs with suspicion, not diffs that
// remove/add a whole cluster of related fields at once.

import fs from "fs";
import path from "path";

const MAX_DEPTH = 8;
const MAX_ARRAY_SAMPLE = 20;

// Distinguishes null and array from plain "object", since those are exactly
// the two cases JS's own typeof lumps together but that matter for
// detecting a real shape change (a field going from array to object, or
// null to a real value, is drift worth flagging).
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Reduces a response down to "what fields exist and what type are they",
// discarding the actual data - the fingerprint is deliberately blind to
// values (a price changing from 10 to 12 isn't schema drift) and only
// sensitive to shape (a price field disappearing, or becoming a string, is).
function fingerprint(value, prefix = "", depth = 0, out = []) {
  const type = typeOf(value);
  if (prefix) out.push(`${prefix}:${type}`);

  if (depth >= MAX_DEPTH) return out;

  if (type === "object") {
    for (const key of Object.keys(value).sort()) {
      fingerprint(value[key], prefix ? `${prefix}.${key}` : key, depth + 1, out);
    }
  } else if (type === "array" && value.length > 0) {
    for (const item of value.slice(0, MAX_ARRAY_SAMPLE)) {
      fingerprint(item, `${prefix}[]`, depth + 1, out);
    }
  }
  return out;
}

export function createSchemaCheck(baselineFilePath) {
  fs.mkdirSync(path.dirname(baselineFilePath), { recursive: true });

  // The actual detection step: first time through just records what
  // "normal" looks like (nothing to compare against yet, so nothing to
  // flag); every time after that, a difference from the recorded baseline
  // *is* the drift this whole module exists to catch. The baseline is
  // updated to match whenever a change is found, so the next run's report
  // reflects new drift rather than repeating the same diff forever.
  function diffAgainstBaseline(current) {
    if (!fs.existsSync(baselineFilePath)) {
      fs.writeFileSync(baselineFilePath, JSON.stringify([...current], null, 2));
      return { changed: false, baselineEstablished: true, added: [], removed: [] };
    }

    const baseline = new Set(JSON.parse(fs.readFileSync(baselineFilePath, "utf8")));
    const added = [...current].filter((p) => !baseline.has(p));
    const removed = [...baseline].filter((p) => !current.has(p));
    const changed = added.length > 0 || removed.length > 0;

    if (changed) {
      fs.writeFileSync(baselineFilePath, JSON.stringify([...current], null, 2));
    }

    return { changed, baselineEstablished: false, added, removed };
  }

  return {
    // Convenience for a single-sample source (e.g. a one-off bulk endpoint
    // like Coop's store list, where there's only one response per run).
    check(sampleObject) {
      return diffAgainstBaseline(new Set(fingerprint(sampleObject)));
    },
    // For sources with many samples per run (e.g. one offers response per
    // store) - accumulate a fingerprint per sample with accumulate(), then
    // call finish() once at the end. Unions across every sample instead of
    // just one, so sparse/optional fields (present on some responses, not
    // others) don't produce false "changed" noise from a single unlucky
    // sample - see the array-sampling note above for why this matters.
    createAccumulator() {
      const union = new Set();
      return {
        accumulate(sampleObject) {
          for (const p of fingerprint(sampleObject)) union.add(p);
        },
        finish() {
          if (union.size === 0) return { changed: false, baselineEstablished: false, added: [], removed: [] };
          return diffAgainstBaseline(union);
        },
      };
    },
  };
}
