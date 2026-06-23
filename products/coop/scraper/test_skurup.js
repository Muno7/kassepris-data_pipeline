import { scrapeUrlsConcurrently } from './coop.js';
import fs from 'fs';

const url = 'https://www.coop.se/butiker-erbjudanden/coop/coop-skurup/';
const outputDir = './test-output';

(async () => {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    await scrapeUrlsConcurrently([url], 10, outputDir);
    console.log(`Test output written to ${outputDir}`);
  } catch (err) {
    console.error('Error during test scrape:', err);
    process.exitCode = 1;
  }
})();
