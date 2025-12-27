import { scrapeUrlsConcurrently } from './coop.js';

const urls = [
  "https://www.coop.se/butiker-erbjudanden/stora-coop/stora-coop-valbo/",
  "https://www.coop.se/butiker-erbjudanden/stora-coop/stora-coop-bollnas/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-hofors/",
  "https://www.coop.se/butiker-erbjudanden/stora-coop/stora-coop-hudiksvall/",
  "https://www.coop.se/butiker-erbjudanden/stora-coop/stora-coop-ljusdal/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-sandviken/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-skutskar/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-bergvik/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-eken-gavle/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-hallen/",
  "https://www.coop.se/butiker-erbjudanden/coop/coop-enen/",
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
