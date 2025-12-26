import puppeteer from 'puppeteer';
import fs from 'fs';


async function selectStore(city) {
    await page.waitForSelector('button.sc-7c8770a6-0.gXFZsu.sc-459c5700-1.fKtGeL'); // wait for the välj butik button
    await page.evaluate(() => {
        const button = document.querySelector('button.sc-7c8770a6-0.gXFZsu.sc-459c5700-1.fKtGeL');
        button.click();
    });


    // Wait for input field to be visible and ready
    await page.waitForSelector('input.sc-29a0f90e-0.bCPowe')

    // Click the input field and type the city
    await page.click('input.sc-29a0f90e-0.bCPowe');
    await page.type('input.sc-29a0f90e-0.bCPowe', city);
    
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
    // Get expected number of products from the paragraph

    console.log(`Expecting ${expectedCount} products...`);

    let currentCount = 0

    while (currentCount < expectedCount) {
        // Count loaded products
        currentCount = await page.evaluate(() =>
            document.querySelectorAll('div.sc-c933ef91-0.eWnNDe').length
        );
        // Scroll to bottom
        await page.evaluate(() => {
            const products = document.querySelectorAll('div.sc-c933ef91-0.eWnNDe'); // product cards
            const lastProduct = products[products.length - 1];
            if (lastProduct) {
                lastProduct.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        });
    }

    console.log(`✅ Done! Total loaded: ${currentCount} products.`);

    return await page.$$('div.sc-c933ef91-0.eWnNDe'); // return product elements
}

let page;

async function getProducts() {
    const browser = await puppeteer.launch({
        headless: false
    });

    page = await browser.newPage();
    await page.goto('https://www.willys.se/erbjudanden/butik');

    await selectStore('skurup');

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

    // Extract category metadata ONCE (no ElementHandles)
    const categories = await page.$$eval(
        'div.sc-c78942f3-2.CXxSM div a',
        anchors =>
            anchors.map(a => {
                const aria = a.getAttribute('aria-label') || '';
                const cleaned = aria.replace(/\s+/g, ' ').trim();

                let name = cleaned;
                let expectedCount = null;

                const match = cleaned.match(/^(.+?)\s+(\d+)\s+produkter$/i);
                if (match) {
                    name = match[1].trim();
                    expectedCount = parseInt(match[2], 10);
                }

                return {
                    name,
                    expectedCount,
                    url: a.href
                };
            })
    );

    // Iterate categories as independent pages
    for (const { name: categoryName, expectedCount, url } of categories) {
        console.log(`\nScraping category: ${categoryName}`);

        await page.goto(url);

        const productElements = await loadProducts(expectedCount);

        console.log(
            `Found ${productElements.length} products (expected ${expectedCount})`
        );

        for (const productElement of productElements) {
            await scrapeProductData(productElement, categoryName);
        }
    }

    await browser.close();
}


async function scrapeProductData(productElement, categoryName) {
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

  pushProductsToJson(productData);
}



let products = [];

async function pushProductsToJson(productData) {
    products.push(productData);
  
    // Save to JSON file
    fs.writeFileSync('willys.json', JSON.stringify(products, null, 2));

}

getProducts();