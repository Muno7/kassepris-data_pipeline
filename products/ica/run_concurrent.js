import { scrapeUrlsConcurrently } from './ica.js';

const urls = [
  "https://www.ica.se/erbjudanden/ica-supermarket-skurup-1004591/",
  "https://www.ica.se/erbjudanden/ica-supermarket-viksang-1003549/",
  // Add more ICA URLs as needed
];

(async () => {
  try {
    console.log('Starting concurrent scrape for ICA URLs...');
    await scrapeUrlsConcurrently(urls);
    console.log('Finished scraping all ICA URLs');
  } catch (err) {
    console.error('Error during concurrent scrape:', err);
    process.exitCode = 1;
  }
})();
