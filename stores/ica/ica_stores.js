import puppeteer from "puppeteer";
import fs from "fs";

// Read the previously scraped JSON with URLs
const urls = JSON.parse(fs.readFileSync("ica_store_links.json", "utf-8"));

async function scrapeStoreNames() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const stores = [];

  for (const url of urls) {
    const prefix = "https://www.ica.se/erbjudanden/";
    const code = url.startsWith(prefix) ? url.slice(prefix.length) : null;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      const sel = "span.storeheader__storename";
      // Use page.$ which returns null if the element isn't found (no throw)
      const el = await page.$(sel);

      let name = null;
      if (el) {
        name = await page.evaluate(e => e.textContent.trim(), el);
        console.log(`Scraped ${name} (${code})`);
      } else {
        // Selector not present on this page — skip name extraction and continue
        console.log(`Selector not found for ${url} — skipping name (code=${code})`);
      }

      stores.push({ code, name, url });
    } catch (err) {
      console.error(`Failed to scrape store ${code}:`, err.message);
      // continue to next URL without throwing
    }
  }

  await browser.close();

  fs.writeFileSync("willys_stores_with_names.json", JSON.stringify(stores, null, 2), "utf-8");
  console.log("Done! Saved to willys_stores_with_names.json");
}

scrapeStoreNames();
