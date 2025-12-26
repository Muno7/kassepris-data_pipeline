import puppeteer from "puppeteer";
import fs from "fs";

// Read the previously scraped JSON with URLs
const urls = JSON.parse(fs.readFileSync("coop_store_links.json", "utf-8"));

async function scrapeStoreNames() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const stores = [];

  for (const url of urls) {
    const prefix = "https://www.coop.se/butiker-erbjudanden/";
    const code = url.startsWith(prefix) ? url.slice(prefix.length) : null;

    try {
      await page.goto(url);

      const sel = ".CpOm61gn h1";
      // Try to read the name; retry until it's non-empty or until max attempts reached
      let el = await page.$(sel);

      let name = null;
      const maxAttempts = 1000;
      let attempts = 0;

      while ((name === null || name === "") && attempts < maxAttempts) {
        if (el) {
          name = await page.evaluate(e => e.textContent.trim(), el);
          if (name) break;
        }

        attempts++;
        el = await page.$(sel);
      }

      if (name) {
        console.log(`Scraped ${name} (${code})`);
      } else {
        console.log(`Could not scrape name for ${url} after ${attempts} attempts — saving null`);
      }

      stores.push({ code, name, url });
    } catch (err) {
      console.error(`Failed to scrape store ${code}:`, err.message);
      // continue to next URL without throwing
    }
  }

  await browser.close();

  fs.writeFileSync("coop_stores.json", JSON.stringify(stores, null, 2), "utf-8");
  console.log("Done! Saved to coop_stores.json");
}

scrapeStoreNames();
