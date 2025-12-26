import puppeteer from "puppeteer";
import fs from "fs";

// Read the previously scraped JSON with URLs
const codes = JSON.parse(fs.readFileSync("willys_store_codes.json", "utf-8"));

async function scrapeStoreNames() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const stores = [];

  for (const code of codes) {
    const url = `https://www.willys.se/butik/${code}`;
    await new Promise(resolve => setTimeout(resolve, 10500));
    try {
      await page.goto(url);
      await page.waitForSelector("h1.sc-e7f7893-0.bcBUYs.sc-640e82ca-2.bgtdzG");

      const name = await page.$eval(
        "h1.sc-e7f7893-0.bcBUYs.sc-640e82ca-2.bgtdzG",
        el => el.textContent.trim()
      );

      stores.push({ code, name, url });
      console.log(`Scraped ${name} (${code})`);
    } catch (err) {
      console.error(`Failed to scrape store ${code}:`, err.message);
    }
  }

  await browser.close();

  fs.writeFileSync("willys_stores_with_names.json", JSON.stringify(stores, null, 2), "utf-8");
  console.log("Done! Saved to willys_stores_with_names.json");
}

scrapeStoreNames();
