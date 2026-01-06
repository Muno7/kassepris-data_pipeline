import fs from 'fs';
import path from 'path';

const INPUT_DIR = '../products/coop/';
const OUTPUT_FILE = './coop_assortments.json';

function getJsonFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

function extractStoreSlug(products) {
  // "coop/coop-norra-djurgardsstaden" → "coop-norra-djurgardsstaden"
  return products[0]?.store?.split('/').pop();
}

function extractSortedFingerprints(products) {
  const set = new Set();

  for (const product of products) {
    if (product.fingerprint) {
      set.add(product.fingerprint);
    }
  }

  return Array.from(set).sort();
}

function main() {
  const files = getJsonFiles(INPUT_DIR);

  /** 
   * Map<
   *   fingerprintKey: string,
   *   {
   *     assortmentId: string,
   *     fingerprints: string[],
   *     stores: string[]
   *   }
   * >
   */
  const assortmentMap = new Map();
  let assortmentCounter = 1;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(INPUT_DIR, file), 'utf-8');
    const products = JSON.parse(raw);

    if (!Array.isArray(products) || products.length === 0) {
      continue;
    }

    const storeSlug = extractStoreSlug(products);
    if (!storeSlug) continue;

    const fingerprints = extractSortedFingerprints(products);

    // This is the critical identity key
    const fingerprintKey = fingerprints.join('|');

    if (assortmentMap.has(fingerprintKey)) {
      assortmentMap.get(fingerprintKey).stores.push(storeSlug);
    } else {
      const assortmentId = `assortment_${assortmentCounter++}`;

      assortmentMap.set(fingerprintKey, {
        assortmentId,
        fingerprints,
        stores: [storeSlug]
      });
    }
  }

  const result = Array.from(assortmentMap.values());

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

  console.log(`Created ${result.length} unique Coop assortments`);
}

main();
