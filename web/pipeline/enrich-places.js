/**
 * Kuromoon Pipeline — Naver Place Metadata Enricher
 * 
 * 1. Reads places.json (or refined_places.json)
 * 2. Identifies places with missing hours, price_range, instagram, or parking
 * 3. Heuristically queries Naver Maps Search to get Naver Place ID
 * 4. Fetches Naver Place Mobile SSR HTML and extracts __APOLLO_STATE__
 * 5. Extracts details:
 *    - hours / businessHours
 *    - price_range (min ~ max of menu prices)
 *    - parking (from conveniences)
 *    - instagram (from sns/homepage links)
 *    - reservation_url (from booking links)
 * 6. Saves the enriched data back to places.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const PLACES_FILE = path.join(DATA_DIR, 'places.json');

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

/**
 * Extract Dong (동) or Gu (구) from Address
 */
function extractRegion(address) {
    if (!address) return '';
    const match = address.match(/([가-힣]+[동구])/);
    return match ? match[1] : '';
}

/**
 * Clean HTML strings
 */
function cleanText(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>?/gm, '').trim();
}

/**
 * Follow redirects and fetch HTML content
 */
function getUrl(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                ...headers
            }
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) {
                    const parsedUrl = new URL(url);
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                }
                return resolve(getUrl(redirectUrl, headers));
            }
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ html: data, url, statusCode: res.statusCode }));
        }).on('error', reject);
    });
}

/**
 * Query Naver Map Mobile Search to find Place ID
 */
async function getNaverPlaceId(placeName, address) {
    const region = extractRegion(address);
    const queryStr = `${placeName} ${region}`.trim();
    const searchUrl = `https://m.map.naver.com/search?query=${encodeURIComponent(queryStr)}`;
    
    try {
        const { html } = await getUrl(searchUrl);
        // Match standard ID in search result JSON
        const match = html.match(/"items"\s*:\s*\[\s*\{\s*"id"\s*:\s*(\d+)/);
        if (match) return match[1];
        
        const altMatch = html.match(/"id"\s*:\s*(\d+)/);
        if (altMatch) return altMatch[1];
    } catch (e) {
        log(`   ⚠️ Search request failed: ${e.message}`);
    }
    
    // Retry with name only if region failed
    if (region) {
        const searchUrlName = `https://m.map.naver.com/search?query=${encodeURIComponent(placeName)}`;
        try {
            const { html } = await getUrl(searchUrlName);
            const match = html.match(/"items"\s*:\s*\[\s*\{\s*"id"\s*:\s*(\d+)/);
            if (match) return match[1];
        } catch (e) {
            log(`   ⚠️ Search retry failed: ${e.message}`);
        }
    }

    // Fallback: Retry searching Map using the address text only (e.g. venue name like "예술의전당 서울서예박물관")
    if (address) {
        log(`   ⚠️ Retrying Naver Place search using address text only: "${address}"`);
        const searchUrlAddr = `https://m.map.naver.com/search?query=${encodeURIComponent(address)}`;
        try {
            const { html } = await getUrl(searchUrlAddr);
            const match = html.match(/"items"\s*:\s*\[\s*\{\s*"id"\s*:\s*(\d+)/);
            if (match) return match[1];
            
            const altMatch = html.match(/"id"\s*:\s*(\d+)/);
            if (altMatch) return altMatch[1];
        } catch (e) {
            log(`   ⚠️ Search fallback by address failed: ${e.message}`);
        }
    }
    return null;
}

/**
 * Fetch Apollo State from Place page
 */
async function fetchApolloState(placeId) {
    // Try restaurant path first, let it redirect to cafe or others
    const detailUrl = `https://m.place.naver.com/restaurant/${placeId}/home`;
    try {
        const { html, statusCode } = await getUrl(detailUrl, { 'Referer': 'https://m.map.naver.com/' });
        if (statusCode === 429) {
            log(`   ⚠️ Naver blocked request (429 - Too Many Requests)`);
            return null;
        }
        
        const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{.*?\});/s);
        if (!apolloMatch) return null;
        
        return JSON.parse(apolloMatch[1]);
    } catch (e) {
        log(`   ⚠️ Failed to fetch/parse details: ${e.message}`);
        return null;
    }
}

/**
 * Extract fields from Apollo State
 */
function extractMetadata(apolloState, placeId) {
    const result = {
        hours: null,
        price_range: null,
        parking: null,
        instagram: null,
        reservation_url: null
    };
    
    const baseKey = `PlaceDetailBase:${placeId}`;
    const baseInfo = apolloState[baseKey];
    
    // 1. Check conveniences (Parking)
    if (baseInfo && baseInfo.conveniences) {
        result.parking = baseInfo.conveniences.some(c => c.includes('주차') || c.includes('발렛'));
    }
    
    // 2. Business Hours
    if (baseInfo && baseInfo.openingHours) {
        result.hours = baseInfo.openingHours;
    } else {
        // Fallback: look for BusinessHours type objects in state
        const hourKeys = Object.keys(apolloState).filter(k => k.startsWith('BusinessHours:'));
        if (hourKeys.length > 0) {
            const firstHours = apolloState[hourKeys[0]];
            if (firstHours && firstHours.businessHours) {
                // e.g. "월~토 11:00~21:00"
                result.hours = firstHours.businessHours;
            }
        }
    }
    
    // Heuristic: Scan conveniences text if description has a time pattern
    if (!result.hours) {
        // Look for typical time strings in descriptions
        for (const k of Object.keys(apolloState)) {
            const val = apolloState[k];
            if (val && val.description && (val.description.includes('⏰') || val.description.includes('영업시간'))) {
                const match = val.description.match(/(⏰|영업시간|월~토|매일|월\s*-\s*토|월요일).*?(\d{2}:\d{2}\s*~\s*\d{2}:\d{2})/);
                if (match) {
                    result.hours = match[0].replace('📍', '').trim();
                    break;
                }
            }
        }
    }
    
    // 3. Price Range (Menu items)
    const menuKeys = Object.keys(apolloState).filter(k => k.startsWith(`Menu:${placeId}_`));
    if (menuKeys.length > 0) {
        const prices = menuKeys
            .map(k => parseInt(apolloState[k].price))
            .filter(p => !isNaN(p) && p > 0);
            
        if (prices.length > 0) {
            const min = Math.min(...prices);
            const max = Math.max(...prices);
            result.price_range = min === max 
                ? `₩${min.toLocaleString()}` 
                : `₩${min.toLocaleString()} ~ ₩${max.toLocaleString()}`;
        }
    }
    
    // 4. Instagram / Homepages
    for (const k of Object.keys(apolloState)) {
        const val = apolloState[k];
        if (!val) continue;
        
        const scanDeep = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(scanDeep);
                return;
            }
            if (obj.url && typeof obj.url === 'string' && obj.url.includes('instagram.com/')) {
                result.instagram = obj.url.trim();
            }
            if (obj.homepage && typeof obj.homepage === 'string' && obj.homepage.includes('instagram.com/')) {
                result.instagram = obj.homepage.trim();
            }
            Object.values(obj).forEach(scanDeep);
        };
        
        scanDeep(val);
    }
    
    // 5. Reservation / Booking URL
    for (const k of Object.keys(apolloState)) {
        const val = apolloState[k];
        if (!val) continue;
        
        const scanDeepBooking = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(scanDeepBooking);
                return;
            }
            if (obj.bookingUrl && typeof obj.bookingUrl === 'string') {
                result.reservation_url = obj.bookingUrl.trim();
            }
            if (obj.url && typeof obj.url === 'string' && obj.url.includes('booking.naver.com')) {
                result.reservation_url = obj.url.trim();
            }
            Object.values(obj).forEach(scanDeepBooking);
        };
        
        scanDeepBooking(val);
    }
    
    return result;
}

async function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon Metadata Auto-Enrichment Pipeline');
    log('═══════════════════════════════════════════');
    
    if (!fs.existsSync(PLACES_FILE)) {
        log(`❌ ${PLACES_FILE} not found.`);
        process.exit(1);
    }
    
    const places = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
    let updatedCount = 0;
    
    for (const place of places) {
        // Only enrich if essential fields are missing and not already enriched
        const needsEnrichment = !place.metadata_enriched && (!place.hours || !place.price_range || place.parking === null || place.parking === false || !place.instagram || !place.reservation_url);
        
        // Skip mock sample places
        const isMockPlace = ['gentlemonster-popup', 'seoul-kbeauty-clinic', 'vegan-table-itaewon', 'cloud-nine-cafe'].includes(place.id);
        
        if (!needsEnrichment || isMockPlace) {
            continue;
        }
        
        log(`\n🔍 Enriching: "${place.name_ko}"`);
        
        // 1. Get Place ID
        const placeId = await getNaverPlaceId(place.name_ko, place.address_ko);
        if (!placeId) {
            log(`   ⚠️ Could not find Naver Place ID`);
            continue;
        }
        log(`   📍 Found Place ID: ${placeId}`);
        
        // 2. Fetch Detail Apollo State
        const apolloState = await fetchApolloState(placeId);
        if (!apolloState) {
            continue;
        }
        
        // 3. Extract Metadata
        const meta = extractMetadata(apolloState, placeId);
        let updated = false;
        
        if (meta.hours && !place.hours) {
            place.hours = meta.hours;
            log(`   ✅ Hours: "${place.hours}"`);
            updated = true;
        }
        if (meta.price_range && !place.price_range) {
            place.price_range = meta.price_range;
            log(`   ✅ Price Range: "${place.price_range}"`);
            updated = true;
        }
        if (meta.parking !== null && place.parking === false) {
            place.parking = meta.parking;
            log(`   ✅ Parking: ${place.parking}`);
            updated = true;
        }
        if (meta.instagram && !place.instagram) {
            place.instagram = meta.instagram;
            log(`   ✅ Instagram: ${place.instagram}`);
            updated = true;
        }
        if (meta.reservation_url && !place.reservation_url) {
            place.reservation_url = meta.reservation_url;
            log(`   ✅ Booking URL: ${place.reservation_url}`);
            updated = true;
        }
        
        // Mark as enriched so we don't hit the Naver maps/details page for it again in the future
        place.metadata_enriched = true;
        updated = true;

        if (updated) {
            updatedCount++;
        }
        
        // Wait 4s between requests to avoid 429 block
        await new Promise(r => setTimeout(r, 4000));
    }
    
    if (updatedCount > 0) {
        fs.writeFileSync(PLACES_FILE, JSON.stringify(places, null, 2), 'utf8');
        log(`\n💾 Saved updated database. ${updatedCount} place(s) enriched.`);
    } else {
        log(`\nℹ️ No new metadata found or updated.`);
    }
    log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    log(`❌ Fatal Error: ${err.message}`);
    process.exit(1);
});
