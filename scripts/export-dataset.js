#!/usr/bin/env node
/**
 * scripts/export-dataset.js
 *
 * Exports all dataset .md + .json files into a single JSON file
 * ready to use as a Laravel seeder data file.
 *
 * Usage:
 *   node scripts/export-dataset.js
 *   node scripts/export-dataset.js --out ./my-output.json
 *   node scripts/export-dataset.js --url http://localhost:4000 --secret mysecret
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Parse args ────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const API_URL = getArg('--url')    || process.env.NODE_API_URL    || 'http://localhost:4000';
const SECRET  = getArg('--secret') || process.env.NODE_API_SECRET || 'supersecret';
const OUT     = getArg('--out')    || path.join(process.cwd(), 'scrapers.json');

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const url = `${API_URL}/jobs/dataset/export`;

    console.log(`\n📦 Exporting dataset from: ${url}`);
    console.log(`📁 Output file: ${OUT}\n`);

    let data;
    try {
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${SECRET}` },
        });

        if (!res.ok) {
            console.error(`❌ API error: HTTP ${res.status} ${res.statusText}`);
            process.exit(1);
        }

        data = await res.json();
    } catch (err) {
        console.error(`❌ Failed to reach API: ${err.message}`);
        console.error(`   Make sure the Node server is running at ${API_URL}`);
        process.exit(1);
    }

    // Write JSON file
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(OUT, json, 'utf8');

    // Summary
    const mdCount     = data.scraper_mds?.length     || 0;
    const configCount = data.scraper_configs?.length  || 0;

    console.log(`✅ Export complete!\n`);
    console.log(`   scraper_mds:     ${mdCount}`);
    console.log(`   scraper_configs: ${configCount}`);
    console.log(`   Output:          ${OUT}\n`);

    // Preview first MD name
    if (mdCount > 0) {
        console.log('📋 MDs found:');
        data.scraper_mds.forEach(md => {
            console.log(`   - ${md.name}`);
        });
    }

    if (configCount > 0) {
        console.log('\n🗺  Configs found:');
        data.scraper_configs.forEach(cfg => {
            console.log(`   - ${cfg.state_code} / ${cfg.county_name} → ${cfg.scraper_md_name} (${cfg.scraper_type})`);
        });
    }

    console.log(`\n💡 Copy ${OUT} to your Laravel project:`);
    console.log(`   database/seeders/data/scrapers.json\n`);
}

main();