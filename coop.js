import puppeteer from 'puppeteer';
import fs from 'fs';

let page;

async function getProducts() {
    const browser = await puppeteer.launch({
    headless: false // Opens visible browser
    });

    page = await browser.newPage();
    await page.goto('https://www.coop.se/butiker-erbjudanden/coop/coop-skurup/');

    await page.waitForSelector('.yHxPkLdx');
    const categoriesDiv = await page.$('.yHxPkLdx');

    // Get all buttons inside the container
    const categoryButtons = await categoriesDiv.$$('button');

    for (let i = 1; i < categoryButtons.length; i++) {
        const button = categoryButtons[i];

        // Get the category name from the span inside the button
        const rawText = await button.evaluate(el =>
            el.textContent.replace(/\s+/g, ' ').trim()
        );

        const match = rawText.match(/^(.+?)\s*\(\s*(\d+)\s*\)$/);
        const categoryName = match ? match[1].trim() : rawText;
        const expectedCount = match ? parseInt(match[2], 10) : null;

        
        console.log('Scraping category:', categoryName);

        // Click the category button to filter products
        await button.evaluate(el => el.click());

        // Wait for the products to load
        await page.waitForSelector('article.ohKiwh8z.xSu5Uapq');

        // Get all product elements
        let productElements = await page.$$('article.ohKiwh8z.xSu5Uapq');

        while (productElements.length !== expectedCount) {
            productElements = await page.$$('article.ohKiwh8z.xSu5Uapq');
        }

        console.log(`Found ${productElements.length} products in category: ${categoryName} with expected count: ${expectedCount}`);

        // Loop through products in this category
        for (const productElement of productElements) {
            await scrapeProductData(productElement, false, categoryName);
        }

        // Click the category button again to reset the filter
        await categoryButtons[1].evaluate(el => el.click());
    }

    await browser.close();
}


async function scrapeProductVariants(productElement) {
    let variants = [];

    // Get the parent of productElement, then find the div within it
    await productElement.evaluate(element => {
        element.querySelector('.Wy2NiM6K.iyTkejCQ._yrJb637.mOvy16Ff').click();
    });
    const variantsDiv = await page.$('.BwcVHsZk.vqviwfSt')
    
    const variantsElements = await variantsDiv.$$('article.ohKiwh8z.xSu5Uapq');
    
    for (const productElement of variantsElements) {
        variants.push(await scrapeProductData(productElement, true));
    }
    
    await variantsDiv.evaluate(element => {
        element.querySelector('.Wy2NiM6K.tkw4k9hc.dIzgXmHF.MV0OfllN').click();
    });
    await page.waitForSelector('.BwcVHsZk.vqviwfSt', { hidden: true });
    
    return variants;
}

async function scrapeProductData(productElement, isVariant, categoryName) {
    const productData = await productElement.evaluate(element => {
        const title = element.querySelector('.OXTlHT32')?.textContent?.trim() || null;
        // Coop sometimes has "30,00" or just "30"
        const rawPrice = element.querySelector('.slH8Imgo span:nth-last-child(2)')?.textContent?.trim()
            || Array.from(element.querySelector('.n1OznkM1')?.childNodes || [])
                .filter(node => node.nodeType === Node.TEXT_NODE)[0]?.textContent?.trim()
            || null;

        let priceCents = null;

        if (rawPrice) {
            // Normalize "30,00" → "30.00" → 3000
            const normalized = rawPrice.replace(',', '.').replace(/[^\d.]/g, '');
            const floatPrice = parseFloat(normalized);
            priceCents = Math.round(floatPrice * 100);
        }

        const unit = element.querySelector('.Oam2mkaA :nth-of-type(2)')?.textContent?.trim() || null;
        const deal =
            element.querySelector('.slH8Imgo')?.querySelector('.u-textMedium')
                ? element.querySelector('.slH8Imgo :nth-of-type(1)')?.textContent?.trim()
                : element.querySelector('.n1OznkM1')?.querySelector('.u-textMedium')
                ? element.querySelector('.n1OznkM1 :nth-of-type(1)')?.textContent?.trim()
                : null;
        const size = (() => {
            const span = element.querySelector('.uLmN8HjX span:nth-last-child(1)');
            return span && !span.classList.contains('q5vMS42j') && span.classList.length === 0
                ? span.textContent.trim()
                : null;
        })();
        const brand =  element.querySelector('.q5vMS42j')?.textContent?.trim() || null;
        const max = element.querySelector('.UWFn16pY div.u-colorRed1')?.textContent?.trim() || null;
        const comparisonPrice = element.querySelector('.UWFn16pY div:nth-last-child(1)')?.textContent?.trim() || null;
        const image = element.querySelector('.q_ToRdGh.FJbxCHJa img')?.src || null;
        const isMember = element.querySelector('.aP5TkjG6.Er3da50N') ? true : false;
        const badges = Array.from(element.querySelectorAll('.VFIPn1KI img')).map(img => img.src) || null;
        const hasVariants = element.querySelector('.Wy2NiM6K.iyTkejCQ._yrJb637.mOvy16Ff') !== null
            
        return {
        title,
        priceCents,
        unit,
        deal,
        size,
        brand,
        max,
        comparisonPrice,
        image,
        isMember,
        badges,
        hasVariants
        };
    });

    productData.categoryName = categoryName;
  
    // if the product has variants and itself is not variant of another product then scrape the variants of that product
    if (!isVariant && productData.hasVariants) {
        productData.variants = await scrapeProductVariants(productElement);
        delete productData.hasVariants;
    }

    // if the product is not a variant of another product then add the product as its own product in json
    if (!isVariant) {
        pushProductsToJson(productData);
    }

    console.log(`Scraped: ${productData.title}`);
    return productData;
}

let products = [];

async function pushProductsToJson(productData) {
    products.push(productData);
  
    // Save to JSON file
    fs.writeFileSync('coop.json', JSON.stringify(products, null, 2));

}

getProducts();