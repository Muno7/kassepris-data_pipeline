import { scrapeUrlsConcurrently } from './coop.js';

const urls = [
  "https://www.coop.se/butiker-erbjudanden/coop/coop-skurup/",
];

(async () => {
  try {
    console.log('Starting concurrent scrape for 10 URLs...');
    await scrapeUrlsConcurrently(urls);
    console.log('Finished scraping all URLs');
  } catch (err) {
    console.error('Error during concurrent scrape:', err);
    process.exitCode = 1;
  }
})();
