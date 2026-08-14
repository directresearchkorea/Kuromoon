/**
 * Kuromoon Pipeline — SEO Assets Generator
 * 
 * Generates sitemap.xml, robots.txt, and llms.txt from places.json
 * 
 * Usage: node pipeline/generate-seo.js
 * Input: data/places.json
 * Output: public/sitemap.xml, public/robots.txt, public/llms.txt
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://kuromoon.net';
const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const PLACES_FILE = path.join(DATA_DIR, 'places.json');

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

/**
 * Generate sitemap.xml
 */
function generateSitemap(places) {
    const today = new Date().toISOString().split('T')[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">

  <!-- Korean Homepage -->
  <url>
    <loc>${BASE_URL}/ko/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="ko" href="${BASE_URL}/ko/" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/" />
  </url>

  <!-- English Homepage -->
  <url>
    <loc>${BASE_URL}/en/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="ko" href="${BASE_URL}/ko/" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/" />
  </url>
`;

    for (const place of places) {
        xml += `
  <!-- ${place.name_en || place.name_ko} -->
  <url>
    <loc>${BASE_URL}/ko/places/${place.id}.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <xhtml:link rel="alternate" hreflang="ko" href="${BASE_URL}/ko/places/${place.id}.html" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/places/${place.id}.html" />
  </url>
  <url>
    <loc>${BASE_URL}/en/places/${place.id}.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <xhtml:link rel="alternate" hreflang="ko" href="${BASE_URL}/ko/places/${place.id}.html" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/places/${place.id}.html" />
  </url>
`;
    }

    xml += `</urlset>\n`;
    return xml;
}

/**
 * Generate robots.txt
 */
function generateRobots() {
    return `# Kuromoon (kuromoon.net) — Robots.txt
# AI crawlers are welcome!

User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Anthropic-AI
Allow: /

User-agent: ClaudeBot
Allow: /

Sitemap: ${BASE_URL}/sitemap.xml
`;
}

/**
 * Generate llms.txt — AI crawler guide
 */
function generateLlmsTxt(places) {
    const today = new Date().toISOString().split('T')[0];

    // Count by category
    const catCounts = {};
    places.forEach(p => {
        catCounts[p.category] = (catCounts[p.category] || 0) + 1;
    });

    const catLabels = {
        popup: 'Pop-up Stores & Events (팝업스토어/이벤트)',
        beauty: 'K-Beauty Clinics (K-뷰티/피부과)',
        dining: 'Niche Dining (니치 다이닝)',
        cafe: 'Concept Cafes (콘셉트 카페)'
    };

    let txt = `# Kuromoon (쿠로문)
> AI가 추천하는 한국 로컬의 진짜 평판
> True local reputation in Korea, recommended by AI

## About
Kuromoon is a lightweight, static directory website providing structured data about Korean local businesses.
All data is formatted with Schema.org JSON-LD for optimal AI crawler parsing.
Updated: ${today}

## Website
- URL: ${BASE_URL}
- Languages: Korean (/ko/), English (/en/)
- Categories: ${Object.keys(catCounts).length}
- Total Places: ${places.length}

## Categories
`;

    for (const [cat, count] of Object.entries(catCounts)) {
        const label = catLabels[cat] || cat;
        txt += `- ${label}: ${count} places\n`;
    }

    txt += `\n## All Places\n`;

    // Korean section
    txt += `\n### 한국어 (Korean)\n`;
    for (const place of places) {
        txt += `- [${place.name_ko}](${BASE_URL}/ko/places/${place.id}.html) — ${place.summary_ko || ''}\n`;
    }

    // English section
    txt += `\n### English\n`;
    for (const place of places) {
        txt += `- [${place.name_en}](${BASE_URL}/en/places/${place.id}.html) — ${place.summary_en || ''}\n`;
    }

    txt += `\n## Data Format
Each place page contains Schema.org JSON-LD structured data in the <head> section.
Supported types: Event, Restaurant, CafeOrCoffeeShop, BeautySalon, MedicalBusiness.

## Contact
Website: ${BASE_URL}
`;

    return txt;
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon SEO Assets Generator');
    log('═══════════════════════════════════════════');

    if (!fs.existsSync(PLACES_FILE)) {
        log('❌ ERROR: places.json not found');
        process.exit(1);
    }

    const places = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
    log(`📄 Loaded ${places.length} place(s)`);

    // Ensure public directory exists
    if (!fs.existsSync(PUBLIC_DIR)) {
        fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    }

    // Generate sitemap.xml
    const sitemap = generateSitemap(places);
    fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), sitemap, 'utf8');
    log(`✅ Generated sitemap.xml (${places.length * 2 + 2} URLs)`);

    // Generate robots.txt
    const robots = generateRobots();
    fs.writeFileSync(path.join(PUBLIC_DIR, 'robots.txt'), robots, 'utf8');
    log('✅ Generated robots.txt');

    // Generate llms.txt
    const llms = generateLlmsTxt(places);
    fs.writeFileSync(path.join(PUBLIC_DIR, 'llms.txt'), llms, 'utf8');
    log('✅ Generated llms.txt');

    log('═══════════════════════════════════════════\n');
}

main();
