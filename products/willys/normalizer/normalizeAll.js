// scripts/normalizeAllWillysStores.js
import fs from 'fs';
import path from 'path';
import { normalizeWillysProduct } from './normalizer.js';

// Willys only scrapes two assortments (not one file per store, like Coop/ICA),
// since stores are grouped into "standard" or "hemma" newspaper assortments.
const inputFiles = [
  { file: '../willys.json', storeCode: 'willys' },
  { file: '../willys-hemma.json', storeCode: 'willys-hemma' },
];

function normalizeAllWillysStores() {
  const outputFile = '../../normalized_data/willys_normalized.json';

  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Use a Map for efficient deduplication by fingerprint
  const productMap = new Map();

  let totalProductsProcessed = 0;
  const errors = [];

  for (const { file, storeCode } of inputFiles) {
    const inputPath = path.join(import.meta.dirname, file);

    if (!fs.existsSync(inputPath)) {
      console.warn(`File not found: ${inputPath}, skipping "${storeCode}"`);
      continue;
    }

    const rawProducts = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`Found ${rawProducts.length} products in "${storeCode}"`);

    rawProducts.forEach(rawProduct => {
      try {
        const normalized = normalizeWillysProduct(rawProduct, storeCode);
        const fingerprint = normalized.fingerprint;

        if (productMap.has(fingerprint)) {
          // Product already exists, add store to the stores array
          const existing = productMap.get(fingerprint);
          if (!existing.stores.includes(normalized.stores[0])) {
            existing.stores.push(normalized.stores[0]);
          }
        } else {
          // New product, add to map
          productMap.set(fingerprint, normalized);
        }

        totalProductsProcessed++;
      } catch (error) {
        errors.push({
          storeCode,
          product: rawProduct.title || 'Unknown',
          error: error.message,
        });
      }
    });
  }

  // Convert Map to Array
  const normalizedProducts = Array.from(productMap.values());

  // Write to single output file
  fs.writeFileSync(
    path.join(import.meta.dirname, outputFile),
    JSON.stringify(normalizedProducts, null, 2)
  );

  // Summary
  console.log('\n=== Normalization Complete ===');
  console.log(`Total products processed: ${totalProductsProcessed}`);
  console.log(`Unique products (after deduplication): ${normalizedProducts.length}`);
  console.log(`Output file: ${outputFile}`);

  if (errors.length > 0) {
    console.log(`\nTotal errors: ${errors.length}`);
    fs.writeFileSync(
      path.join(import.meta.dirname, './normalization-errors.json'),
      JSON.stringify(errors, null, 2)
    );
    console.log('Error details written to normalization-errors.json');
  }
}

normalizeAllWillysStores();
