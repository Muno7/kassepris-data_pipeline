import { scrapeUrlsConcurrently } from './coop.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve('../../../.env') });
const DATABASE_URL = process.env.DB_URL;

if (!DATABASE_URL) {
  console.error("Error: DATABASE_URL is undefined. Check your .env file.");
  process.exit(1);
}

// Function to fetch all Coop store URLs
async function getCoopUrls() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      `SELECT url
       FROM stores s
       JOIN chain c ON s.chain_id = c.id
       WHERE c.slug = 'coop'`
    );

    // Extract URLs as an array of strings
    return rows.map(row => row.url).filter(Boolean);
  } catch (err) {
    console.error('Failed to fetch Coop URLs:', err);
    return [];
  } finally {
    client.release();
    await pool.end();
  }
}

(async () => {
  try {
    const urls = await getCoopUrls();
    console.log(`Starting concurrent scrape for ${urls.length} Coop URLs...`);

    // Start timer
    const startTime = Date.now();

    await scrapeUrlsConcurrently(urls);

    // End timer and log elapsed time
    const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
    console.log(`Finished scraping all URLs in ${elapsedTime.toFixed(2)} seconds`);
  } catch (err) {
    console.error('Error during concurrent scrape:', err);
    process.exitCode = 1;
  }
})();
