/**
 * index.js — CLI entry point (local use only)
 *
 * For production/cloud, Laravel calls server.js (Express API) instead.
 * This file is kept for local testing of both type1 and type2.
 *
 * Usage:
 *   node index.js --scraper=bot   --state=OH --county=Butler --book=123 --page=456 --propertyId=789
 *   node index.js --scraper=human --state=OH --county=Butler --book=123 --page=456 --propertyId=789
 */

'use strict';

const helper = require('./helper.js');
const dotenv = require('dotenv');
const path   = require('path');

(async function () {

    dotenv.config({ path: path.resolve(__dirname, '.env') });

    const helperInstance = new helper();
    const args           = helperInstance.collectArguments();

    const scraperType = (args.scraper || 'bot').toLowerCase();
    const { scraper: _s, ...query } = args;

    let ScraperClass;
    if (scraperType === 'human') {
        ScraperClass = require('./app/scrapers/propertyScraperHuman.js');
        console.info('[index] type2 — human in the loop (Browserbase)');
    } else {
        ScraperClass = require('./app/scrapers/propertyScraper.js');
        console.info('[index] type1 — fully automated (local)');
    }

    const instance = new ScraperClass({
        query,
        // Provide simple terminal callbacks for local testing of type2
        onHandoff: async ({ liveViewUrl, message }) => {
            console.log(`\n[handoff] ${message}`);
            if (liveViewUrl) console.log(`[handoff] Live session: ${liveViewUrl}`);
            await new Promise(resolve => {
                const readline = require('readline');
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question('\nPress Enter when done in the browser: ', () => { rl.close(); resolve(); });
            });
        },
        onComplete: async ({ filePath }) => {
            console.log(`[complete] File saved: ${filePath}`);
        },
        onError: async ({ error }) => {
            console.error(`[error] ${error}`);
        },
    });

    try {
        await instance.startNow();
    } catch (error) {
        console.error('[index] fatal:', error);
    } finally {
        process.exit(0);
    }

})();