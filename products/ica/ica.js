import puppeteer from 'puppeteer';
import fs from 'fs';


async function getProducts() {
    const browser = await puppeteer.launch({
    headless: false // Opens visible browser
    });

    const page = await browser.newPage();
    await page.goto('https://www.ica.se/erbjudanden/ica-supermarket-skurup-1004591/');

    const categoriesDiv = await page.$('.ids-scrollable-button-row__inner--sm.ids-scrollable-button-row__inner');

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
        
        console.log('Scraping category:', categoryName);

        // Click the category button to filter products
        await button.evaluate(el => el.click());

        // Wait for the products to load
        await page.waitForSelector('article.offer-card');

        // Get all product elements
        let productElements = await page.$$('article.offer-card');

        while (productElements.length !== expectedCount) {
            productElements = await page.$$('article.offer-card');
        }

        console.log(`Found ${productElements.length} products in category: ${categoryName} with expected count: ${expectedCount}`);

        // Loop through products in this category
        for (const productElement of productElements) {
            const infoButton = await productElement.$('.offer-card__info-container');
            if (infoButton) {
                await infoButton.evaluate(el => el.click());
                await page.waitForSelector('.ids-modal-base__container-inner');
                const productOverlay = await page.$('.ids-modal-base__container-inner');
                await scrapeProductData(productOverlay, categoryName); // pass category to your scrape function
            }
        }

        // Click the category button again to reset the filter
        await categoryButtons[1].evaluate(el => el.click());
    }
    

    await browser.close();
}

async function scrapeProductData(productOverlay, categoryName) {
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
    
    productData.categoryName = categoryName;

    pushProductsToJson(productData);
    return productData;
}

let products = [];

async function pushProductsToJson(productData) {
    products.push(productData);
  
    // Save to JSON file
    fs.writeFileSync('ica.json', JSON.stringify(products, null, 2));

}

getProducts();