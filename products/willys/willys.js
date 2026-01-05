import puppeteer from 'puppeteer';
import fs from 'fs';

let page;
let products = [];

async function selectStore(code) {
    await page.waitForSelector('button.sc-7c8770a6-0.gXFZsu.sc-459c5700-1.fKtGeL'); // wait for the välj butik button
    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.gXFZsu.sc-459c5700-1.fKtGeL');
        button.click();
    });

    // Wait for input field to be visible and ready
    await page.waitForSelector('input.sc-29a0f90e-0.bCPowe')

    // Click the input field and type the code
    await page.click('input.sc-29a0f90e-0.bCPowe');
    await page.type('input.sc-29a0f90e-0.bCPowe', code);
    
    await page.waitForSelector('div.sc-1a26c59f-1.hwwhnV');

    await page.evaluate(() => {
        const div = document.querySelector('div.sc-1a26c59f-1.hwwhnV');
        div.click();
    });

    await page.waitForSelector('div.sc-c933ef91-0.eWnNDe') // wait for the first product to appear
}

async function loadProducts(expectedCount) {
    await page.waitForSelector('p.sc-117d48af-0.dGUcxD'); // wait for the expected count paragraph
    await page.waitForSelector('div.sc-c933ef91-0.eWnNDe'); // wait for product cards to load

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    
    console.log(`Expecting ${expectedCount} products...`);

    let currentCount = 0

    const maxWaitTime = 3000; // 30 seconds timeout
    const startTime = Date.now();

    while (currentCount !== expectedCount && Date.now() - startTime < maxWaitTime) {
        // Count loaded products
        currentCount = await page.evaluate(() =>
            document.querySelectorAll('div.sc-c933ef91-0.eWnNDe').length
        );
        console.log('Loaded products:', currentCount);
        
        // Scroll to bottom
        await page.evaluate(() => {
            const products = document.querySelectorAll('div.sc-c933ef91-0.eWnNDe');
            const lastProduct = products[products.length - 1];
            if (lastProduct) {
                lastProduct.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        });
    }

    // If we didn't get the expected count, take the last expectedCount products
    let productsToProcess;
    if (currentCount !== expectedCount) {
        console.log(`Timeout: Expected ${expectedCount} products but found ${currentCount}. Taking last ${expectedCount} products.`);
        
        const productElements = await page.$$('div.sc-c933ef91-0.eWnNDe');
        
        // Take only the last expectedCount products
        productsToProcess = productElements.slice(-expectedCount);
        
    } else {
        console.log(`Successfully loaded all ${expectedCount} products`);
        productsToProcess = await page.$$('div.sc-c933ef91-0.eWnNDe');
    }

    await page.evaluate(() => {
        window.scrollTo({
            top: 0,
            left: 0,
            behavior: 'smooth'
        });
    });

    console.log(`✅ Done! Total loaded: ${currentCount} products.`);

    return productsToProcess; // return product elements
}

async function getProducts(code, browser) {
    page = await browser.newPage();
    await page.goto('https://www.willys.se/erbjudanden/butik');

    await selectStore(code);
    
    // Open filter panel
    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.hqchDi.sc-3afb827d-6.dmSoed');
        button.click();
    });

    // Open category panel
    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.cUBBNt.sc-c78942f3-0.danpMf');
        button.click();
    });

    // Get all category links
    const categoryLinks = await page.$$('div.sc-c78942f3-2.CXxSM div a');
    const categoryCount = categoryLinks.length;

    console.log(`\nFound ${categoryCount} categories`);

    // Iterate through each category link by index
    for (let i = 0; i < categoryCount; i++) {
        // Re-query the category links and get the link at index i
        const freshCategoryLinks = await page.$$('div.sc-c78942f3-2.CXxSM div a');
        const link = freshCategoryLinks[i];

        // Get category name and expected count from the link
        const { name: categoryName, expectedCount } = await link.evaluate(el => {
            const aria = el.getAttribute('aria-label') || '';
            const cleaned = aria.replace(/\s+/g, ' ').trim();

            let name = cleaned;
            let expectedCount = null;

            const match = cleaned.match(/^(.+?)\s+(\d+)\s+produkter$/i);
            if (match) {
                name = match[1].trim();
                expectedCount = parseInt(match[2], 10);
            }
            return { name, expectedCount };
        });
        await link.evaluate(el => el.click());
        // Wait for the visa varor button and click it
        await page.waitForSelector('button.sc-7c8770a6-0.dbbSSn.sc-3afb827d-5.dkTgEb');
        await page.evaluate(() => {
            const button = document.querySelector('button.sc-7c8770a6-0.dbbSSn.sc-3afb827d-5.dkTgEb')
            button.click();
        });
        console.log(`\nScraping category: ${categoryName}`);
        console.log('link clicked');
        console.log('expectedCount', expectedCount);

        const productElements = await loadProducts(expectedCount);

        console.log(
            `Found ${productElements.length} products (expected ${expectedCount})`
        );

        for (const productElement of productElements) {
            await scrapeProductData(productElement, categoryName, code);
        }

        await page.evaluate(() => {
            const button = document.querySelector('button.sc-7c8770a6-0.jtQuAZ.sc-6e230f45-0.jdTVKr');
            button.click();
        });
        await page.evaluate(() => {
            const button = document.querySelector('button.sc-7c8770a6-0.hqchDi.sc-3afb827d-6.dmSoed');
            button.click();
        });
    }

    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.cUBBNt.sc-c78942f3-0.iEfkXE');
        button.click();
    });

    await page.waitForSelector('button.sc-7c8770a6-0.dbbSSn.sc-3afb827d-5.dkTgEb');
    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.dbbSSn.sc-3afb827d-5.dkTgEb')
        button.click();
    });

    await page.close();
}

async function scrapeProductData(productElement, categoryName, code) {
  const productData = await productElement.evaluate(element => {
    const title = element.querySelector('.sc-c933ef91-7.dfhPxx')?.textContent?.trim() || null;

    // Brand & size
    const brandSizeText = element.querySelector('.sc-c933ef91-9.dQtuYt')?.textContent?.trim() || null;
    let brand = null, size = null;
    if (brandSizeText) {
      const parts = brandSizeText.split(/\s+/);
      brand = parts[0] || null;
      size = parts.slice(1).join(' ') || null;
    }
    const unit = element.querySelector('.sc-4b8cc2f9-6.jxQDEl')?.textContent?.trim() || null;
    // Price info
    const priceMajor = element.querySelector('.sc-4b8cc2f9-2.cCZiOx')?.textContent?.trim() || '0';
    const priceMinor = element.querySelector('.sc-4b8cc2f9-5.ggAScU')?.textContent?.trim() || '00';

    // Combine into a float, normalize commas, and convert to cents
    const normalizedPrice = `${priceMajor}.${priceMinor}`.replace(',', '.');
    const floatPrice = parseFloat(normalizedPrice);
    const priceCents = !isNaN(floatPrice) ? Math.round(floatPrice * 100) : null;

    // Deal type (e.g. "5 för", "3 för")
    const deal = element.querySelector('.sc-c933ef91-14.iSfvdv')?.textContent?.trim() || null;

    // Multiple badges
    const badges = Array.from(element.querySelectorAll('.sc-c933ef91-20.bLaPaP')).map(img => img.src) || null;
    const isMemeber = !!element.querySelector('.sc-e20bc8d3-1.bdMExn.sc-4b8cc2f9-7.chdLmu svg');
    const image = element.querySelector('img[itemprop="image"]')?.src || null;

    return {
      title,
      priceCents,
      unit,
      deal,
      size,
      brand,
      image,
      isMemeber,
      badges
    };
  });

  productData.categoryName = categoryName;

  pushProductsToJson(productData, code);
}

async function pushProductsToJson(productData, code) {
    products.push(productData);
  
    // Save to JSON file
    fs.writeFileSync(`${code}.json`, JSON.stringify(products, null, 2));
}

// Main execution
async function main() {
    const storeCodes = ['willys', 'willys-hemma'];
    
    
    for (const code of storeCodes) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Starting scrape for: ${code}`);
        console.log(`${'='.repeat(60)}\n`);
        
        const browser = await puppeteer.launch({
            headless: false
        });
        // Reset products array for each store
        products = [];
        
        await getProducts(code, browser);
        
        console.log(`\n✅ Completed scraping for ${code}`);
        console.log(`   Total products saved: ${products.length}`);
        console.log(`   File saved as: ${code}.json\n`);
        await browser.close();
    }

    console.log('\n🎉 All stores scraped successfully!');
}

await main();