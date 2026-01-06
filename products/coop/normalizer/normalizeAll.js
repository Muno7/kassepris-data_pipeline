// scripts/normalizeAllCoopStores.js
import fs from 'fs';
import path from 'path';
import { normalizeCoopProduct } from './normalizer.js';

function normalizeAllCoopStores() {
  // Define your input and output
  const inputDir = '../data/';
  const outputFile = '../../normalized_data/coop_normalized.json';
  
  // Ensure output directory exists
  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Read all files from input directory
  const files = fs.readdirSync(inputDir);
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  
  console.log(`Found ${jsonFiles.length} JSON files to normalize\n`);
  
  // Use a Map for efficient deduplication by fingerprint
  const productMap = new Map();
  
  let totalProductsProcessed = 0;
  let filesWithErrors = 0;
  const errors = [];
  
  // Process each file
  jsonFiles.forEach((file, index) => {
    const inputPath = path.join(inputDir, file);
    
    try {
      const rawProducts = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      
      rawProducts.forEach(rawProduct => {
        try {
          const normalized = normalizeCoopProduct(rawProduct);
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
            file, 
            product: rawProduct.title || 'Unknown', 
            error: error.message 
          });
        }
      });
      
      // Log progress every 50 files
      if ((index + 1) % 50 === 0) {
        console.log(`Progress: ${index + 1}/${jsonFiles.length} files processed`);
        console.log(`  Unique products so far: ${productMap.size}`);
        console.log(`  Total products processed: ${totalProductsProcessed}`);
      }
    } catch (error) {
      filesWithErrors++;
      errors.push({ file, error: error.message });
      console.error(`Error reading file ${file}:`, error.message);
    }
  });
  
  // Convert Map to Array
  const normalizedProducts = Array.from(productMap.values());
  
  // Write to single output file
  fs.writeFileSync(
    outputFile,
    JSON.stringify(normalizedProducts, null, 2)
  );
  
  // Summary
  console.log('\n=== Normalization Complete ===');
  console.log(`Files processed: ${jsonFiles.length}`);
  console.log(`Files with errors: ${filesWithErrors}`);
  console.log(`Total products processed: ${totalProductsProcessed}`);
  console.log(`Unique products (after deduplication): ${normalizedProducts.length}`);
  console.log(`Products saved: ${totalProductsProcessed - normalizedProducts.length}`);
  console.log(`Output file: ${outputFile}`);
  
  if (errors.length > 0) {
    console.log(`\nTotal errors: ${errors.length}`);
    
    // Write errors to a file
    fs.writeFileSync(
      './normalization-errors.json',
      JSON.stringify(errors, null, 2)
    );
    console.log('Error details written to normalization-errors.json');
  }
}

// Run the script
normalizeAllCoopStores();