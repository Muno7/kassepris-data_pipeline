import puppeteer from 'puppeteer';
import fs from 'fs';

function extractJsonFileName(url) {
    const match = url.match(/\/([^/]+)\/?$/);
    const storePath = match ? match[1] : 'store';
    // Remove trailing -numbers pattern (e.g., "ica-supermarket-skurup-1004591" → "ica-supermarket-skurup")
    return storePath.replace(/-\d+$/, '');
}

function extractStorePathFromUrl(url) {
    const prefix = 'https://www.ica.se/erbjudanden/';
    return url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, '') : url;
}

function generateFingerprint(productData) {
    // Create fingerprint from all properties except badges, variants, categoryName, image, store, and fingerprint
    const {moreInfo, badges, variants, categoryName, fingerprint, image, store, ...fingerprintProps} = productData;
    const fingerprints = Object.values(fingerprintProps)
        .map(v => {
            // Handle null/undefined explicitly, preserve booleans and other falsy values
            if (v === null || v === undefined) {
                return 'NULL';
            }
            return String(v).toUpperCase().replace(/\s/g, '');
        })
        .join('');
    return fingerprints;
}

async function scrapeUrl(url) {
    const storeName = extractJsonFileName(url);
    const storePath = extractStorePathFromUrl(url);
    const products = []; // Store-specific products array

    const browser = await puppeteer.launch({
        headless: false // Opens visible browser
    });

    const page = await browser.newPage();
    await page.goto(url);

    try {
        const categoriesDiv = await page.$('.ids-scrollable-button-row__inner--sm.ids-scrollable-button-row__inner');
        
        if (!categoriesDiv) {
            console.log(`[${storeName}] No categories found. Store has no products. Terminating.`);
            await browser.close();
            return;
        }

        // Get all buttons inside the container
        const categoryButtons = await categoriesDiv.$$('button.ids-button.ids-button--sm.ids-button-default');
        
        for (let i = 1; i < categoryButtons.length; i++) {
            const button = categoryButtons[i];

            // Get the category name from the span inside the button
            const rawCategoryText = await button.$eval(
                'span',
                span => span.textContent.trim()
            );

            const match = rawCategoryText.match(/^(.+?)\s*\((\d+)\)$/);
            const categoryName = match ? match[1].trim() : rawCategoryText;
            const expectedCount = match ? parseInt(match[2], 10) : null;
            
            console.log(`[${storeName}] Scraping category:`, categoryName);

            // Click the category button to filter products
            await button.evaluate(el => el.click());

            // Wait for the products to load
            try {
                await page.waitForSelector('article.offer-card', { timeout: 10000 });
            } catch (err) {
                console.log(`[${storeName}] No products found for category ${categoryName}. Terminating store scrape.`);
                await browser.close();
                return;
            }

            // Get all product elements
            let productElements = await page.$$('article.offer-card');

            while (productElements.length !== expectedCount) {
                productElements = await page.$$('article.offer-card');
            }

            console.log(`[${storeName}] Found ${productElements.length} products in category: ${categoryName} with expected count: ${expectedCount}`);

            // Loop through products in this category
            for (const productElement of productElements) {
                const infoButton = await productElement.$('.offer-card__info-container');
                if (infoButton) {
                    await infoButton.evaluate(el => el.click());
                    await page.waitForSelector('.ids-modal-base__container-inner');
                    const productOverlay = await page.$('.ids-modal-base__container-inner');
                    await scrapeProductData(productOverlay, categoryName, storeName, storePath, products);
                }
            }

            // Click the category button again to reset the filter
            await categoryButtons[1].evaluate(el => el.click());
        }
        
        await browser.close();
    } catch (err) {
        console.error(`[${storeName}] Unexpected error during scraping:`, err.message);
        await browser.close();
    }
}

async function scrapeProductData(productOverlay, categoryName, storeName, storePath, products) {
    const productData = await productOverlay.evaluate(element => {
        let title = element.querySelector('.ids-modal-base__title')?.textContent?.trim() || null; /* change if later if we have only one variant for more detailed title */
        const image = element.querySelector('.innerImageContainer.image img')?.src || null;
        const priceText = element.querySelector('.price-splash__text__firstValue')?.textContent?.trim() || null;
        const centsText = element.querySelector('.price-splash__text__secondaryValue')?.textContent?.trim() || null;

        let priceCents = null;

        if (priceText) {
            // Combine crowns and cents into a single integer (e.g., 29 kr + 90 öre = 2990)
            const crowns = parseInt(priceText.replace(/\D/g, '')) || 0;
            const cents = parseInt(centsText?.replace(/\D/g, '') || '0');
            priceCents = crowns * 100 + cents;
        }


        const unit = element.querySelector('.price-splash__text__suffix')?.textContent?.trim() || null;
        const deal =  element.querySelector('.price-splash__text__prefix')?.textContent?.trim() || null;
        const detailDivs = element.querySelectorAll('.detailsContainerInner > div');
        const isMember = element.querySelector('.price-splash__icon.price-splash__icon--stammis') ? true : false;

        let size = null;
        let brand = null;
        let comparisonPrice = null;
        let moreInfo = null;

        detailDivs.forEach(div => {
        const label = div.querySelector('.label')?.textContent?.trim();
        const text = div.querySelector('.text')?.textContent?.trim();

        if (!label || !text) return;

        if (label.includes('Vikt/Volym')) {
            size = text;
        } else if (label.includes('Leverantör/Land')) {
            brand = text;
        } else if (label.includes('Jmfpris')) {
            comparisonPrice = text ;
        } else if (label.includes('Mer information')) {
            moreInfo = text;
        }
        });
        
        let variants = null;
        const variantElements = element.querySelectorAll('.articleList .articleListItem__item');

        if (variantElements.length > 1) {
            variants = Array.from(variantElements).map(li => {
                const name = li.querySelector('.articleTitle')?.textContent?.trim() || null;
                const picture = li.querySelector('.articleImage')?.getAttribute('src') || null;
                return { name, picture };
            });
        }
    
        return {
            title,
            priceCents,
            unit,
            deal,
            size,
            brand,
            moreInfo,
            comparisonPrice,
            image,
            isMember,
            variants
        };
    });
    
    // Generate fingerprint and add metadata only for parent products
    productData.categoryName = categoryName;
    productData.store = storePath;
    const fingerprint = generateFingerprint(productData);
    productData.fingerprint = fingerprint;

    pushProductsToJson(productData, products, storeName);
    return productData;
}

let products = [];

async function pushProductsToJson(productData, products, storeName) {
    products.push(productData);
  
    // Save to store-specific JSON file
    const filename = `${storeName}.json`;
    fs.writeFileSync(filename, JSON.stringify(products, null, 2));
}

// Scrape multiple URLs concurrently, each in its own browser instance
export async function scrapeUrlsConcurrently(urls) {
    const promises = urls.map(url => scrapeUrl(url));
    await Promise.all(promises);
}