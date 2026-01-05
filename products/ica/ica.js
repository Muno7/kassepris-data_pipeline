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

async function scrapeUrl(url, browser, workerNum) {
    const storeName = extractJsonFileName(url);
    const storePath = extractStorePathFromUrl(url);
    const products = []; // Store-specific products array
    let page = null;

    try {
        console.log(`[Worker ${workerNum}] Starting: ${storeName}`);
        page = await browser.newPage();
        
        // Set a timeout for the page
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(30000);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const categoriesDiv = await page.$('.ids-scrollable-button-row__inner--sm.ids-scrollable-button-row__inner');
        
        if (!categoriesDiv) {
            console.log(`[Worker ${workerNum}][${storeName}] No categories found. Store has no products.`);
            await page.close();
            return;
        }

        // Get all buttons inside the container
        const categoryButtons = await categoriesDiv.$$('button.ids-button.ids-button--sm.ids-button-default');
        
        for (let i = 1; i < categoryButtons.length; i++) {
            try {
                const button = categoryButtons[i];

                // Get the category name from the span inside the button
                const rawCategoryText = await button.$eval(
                    'span',
                    span => span.textContent.trim()
                );

                const match = rawCategoryText.match(/^(.+?)\s*\((\d+)\)$/);
                const categoryName = match ? match[1].trim() : rawCategoryText;
                const expectedCount = match ? parseInt(match[2], 10) : null;
                
                console.log(`[Worker ${workerNum}][${storeName}] Scraping category: ${categoryName}`);

                // Click the category button to filter products
                await button.evaluate(el => el.click());

                // Wait for the products to load
                try {
                    await page.waitForSelector('article.offer-card', { timeout: 10000 });
                } catch (err) {
                    console.log(`[Worker ${workerNum}][${storeName}] No products found for category ${categoryName}. Skipping category.`);
                    continue;
                }

                // Get all product elements
                let productElements = await page.$$('article.offer-card');

                // Wait for expected count with timeout
                let attempts = 0;
                const maxAttempts = 20;
                while (productElements.length !== expectedCount && attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    productElements = await page.$$('article.offer-card');
                    attempts++;
                }

                console.log(`[Worker ${workerNum}][${storeName}] Found ${productElements.length} products in category: ${categoryName} (expected: ${expectedCount})`);

                // Loop through products in this category
                for (const productElement of productElements) {
                    try {
                        const infoButton = await productElement.$('.offer-card__info-container');
                        if (infoButton) {
                            await infoButton.evaluate(el => el.click());
                            await page.waitForSelector('.ids-modal-base__container-inner', { timeout: 5000 });
                            const productOverlay = await page.$('.ids-modal-base__container-inner');
                            await scrapeProductData(productOverlay, categoryName, storeName, storePath, products);
                        }
                    } catch (productErr) {
                        console.error(`[Worker ${workerNum}][${storeName}] Error scraping individual product:`, productErr.message);
                        // Continue to next product
                    }
                }

                // Click the category button again to reset the filter
                try {
                    await categoryButtons[1].evaluate(el => el.click());
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (resetErr) {
                    console.error(`[Worker ${workerNum}][${storeName}] Error resetting filter:`, resetErr.message);
                }
            } catch (categoryErr) {
                console.error(`[Worker ${workerNum}][${storeName}] Error in category ${i}:`, categoryErr.message);
                // Continue to next category
            }
        }
        
        await page.close();
        console.log(`[Worker ${workerNum}][${storeName}] ✅ Completed. Total products: ${products.length}`);
    } catch (err) {
        console.error(`[Worker ${workerNum}][${storeName}] ❌ Critical error:`, err.message);
        if (page) {
            try {
                await page.close();
            } catch (closeErr) {
                console.error(`[Worker ${workerNum}][${storeName}] Error closing page:`, closeErr.message);
            }
        }
    }
}

async function scrapeProductData(productOverlay, categoryName, storeName, storePath, products) {
    try {
        const productData = await productOverlay.evaluate(element => {
            let title = element.querySelector('.ids-modal-base__title')?.textContent?.trim() || null;
            const image = element.querySelector('.innerImageContainer.image img')?.src || null;
            const priceText = element.querySelector('.price-splash__text__firstValue')?.textContent?.trim() || null;
            const centsText = element.querySelector('.price-splash__text__secondaryValue')?.textContent?.trim() || null;

            let priceCents = null;

            if (priceText) {
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
                    comparisonPrice = text;
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
        
        productData.categoryName = categoryName;
        productData.store = storePath;
        const fingerprint = generateFingerprint(productData);
        productData.fingerprint = fingerprint;

        pushProductsToJson(productData, products, storeName);
        return productData;
    } catch (err) {
        console.error(`Error scraping product data:`, err.message);
    }
}

async function pushProductsToJson(productData, products, storeName) {
    try {
        products.push(productData);
        const filename = `${storeName}.json`;
        fs.writeFileSync(filename, JSON.stringify(products, null, 2));
    } catch (err) {
        console.error(`Error writing to JSON file ${storeName}.json:`, err.message);
    }
}

// Worker function that processes a chunk of URLs sequentially
async function worker(urls, workerNum) {
    let browser = null;
    
    try {
        console.log(`[Worker ${workerNum}] Launching browser for ${urls.length} stores...`);
        browser = await puppeteer.launch({ 
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            console.log(`[Worker ${workerNum}] Progress: ${i + 1}/${urls.length}`);
            
            try {
                await scrapeUrl(url, browser, workerNum);
            } catch (urlErr) {
                console.error(`[Worker ${workerNum}] Failed to scrape ${url}:`, urlErr.message);
                // Continue to next URL even if this one failed
            }
            
            // Small delay between stores
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`[Worker ${workerNum}] ✅ All stores completed!`);
    } catch (err) {
        console.error(`[Worker ${workerNum}] ❌ Worker error:`, err.message);
    } finally {
        if (browser) {
            try {
                await browser.close();
                console.log(`[Worker ${workerNum}] Browser closed.`);
            } catch (closeErr) {
                console.error(`[Worker ${workerNum}] Error closing browser:`, closeErr.message);
            }
        }
    }
}

// Scrape with 5 persistent browsers
export async function scrapeUrlsConcurrently(urls, numWorkers = 5) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Starting scrape for ${urls.length} stores using ${numWorkers} persistent browsers`);
    console.log(`${'='.repeat(70)}\n`);

    // Distribute URLs evenly among workers
    const chunks = Array.from({ length: numWorkers }, () => []);
    urls.forEach((url, index) => {
        chunks[index % numWorkers].push(url);
    });

    // Log distribution
    chunks.forEach((chunk, i) => {
        console.log(`[Worker ${i + 1}] Assigned ${chunk.length} stores`);
    });
    console.log('');

    // Start all workers in parallel
    const workerPromises = chunks.map((chunk, index) => 
        worker(chunk, index + 1)
    );

    await Promise.all(workerPromises);

    console.log('\n🎉 All workers completed! All stores scraped.');
}