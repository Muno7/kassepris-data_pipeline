import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";
import { scrapeUrlsConcurrently } from "./ica.js";

// Load env
dotenv.config({ path: path.resolve("../../.env") });

const DATABASE_URL = process.env.DB_URL;
if (!DATABASE_URL) {
  throw new Error("DB_URL is not defined in .env");
}

// Create pool
const pool = new Pool({
  connectionString: DATABASE_URL
});

// Fetch ICA URLs from DB
async function getIcaUrls() {
  const { rows } = await pool.query(`
    SELECT s.url
    FROM public.store s
    JOIN public.chain c ON s.chain_id = c.id
    WHERE c.slug = 'ica'
    ORDER BY s.url
  `);

  // rows = [{ url: '...' }, ...]
  return rows.map(r => r.url);
}

(async () => {
  const startTime = Date.now();
  
  try {
    console.log("\n" + "=".repeat(70));
    console.log("ICA SCRAPER - STARTING");
    console.log("=".repeat(70) + "\n");
    
    console.log("Fetching ICA URLs from database...");
    const urls = await getIcaUrls();

    console.log(`✅ Found ${urls.length} ICA store URLs\n`);
    
    if (urls.length === 0) {
      throw new Error("No ICA URLs found in database");
    }
    
    console.log("Starting concurrent scrape with 5 persistent browsers...");
    console.log("This will take several hours. The script is error-resistant and will continue even if individual stores fail.\n");
    
    // Start the scraping process
    await scrapeUrlsConcurrently(urls, 5);

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000 / 60); // minutes
    
    console.log("\n" + "=".repeat(70));
    console.log("✅ SCRAPING COMPLETED SUCCESSFULLY");
    console.log(`Total time: ${duration} minutes`);
    console.log("=".repeat(70) + "\n");
    
  } catch (err) {
    console.error("\n" + "=".repeat(70));
    console.error("❌ FATAL ERROR - Script terminated");
    console.error("=".repeat(70));
    console.error("Error details:", err.message);
    console.error("Stack trace:", err.stack);
    process.exitCode = 1;
  } finally {
    console.log("\nClosing database connection...");
    await pool.end();
    console.log("Database connection closed.\n");
  }
})();