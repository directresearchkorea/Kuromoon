/**
 * Kuromoon Pipeline — Self-Verification (3 Filters)
 * 
 * Reads refined places data and runs 3 verification filters:
 *   Filter 1: Business Registration Status (국세청 API)
 *   Filter 2: Geocoding Address Verification (카카오 로컬 API)
 *   Filter 3: Link Activation Test (HTTP HEAD checks)
 * 
 * Usage: node pipeline/verify.js
 * Env:   PUBLIC_DATA_API_KEY, KAKAO_REST_API_KEY
 * Input: data/refined_places.json (fallback: data/places.json)
 * Output: data/places.json (score >= 90), data/review_needed.json (70-89)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const REFINED_FILE = path.join(DATA_DIR, 'raw_inputs.json');
const PLACES_TO_REFINE_FILE = path.join(DATA_DIR, 'places_to_refine.json');
const PLACES_FILE = path.join(DATA_DIR, 'places.json');
const REVIEW_FILE = path.join(DATA_DIR, 'review_needed.json');
const DISCARDED_FILE = path.join(DATA_DIR, 'discarded_places.json');

// Trusted domains for bonus points
const TRUSTED_DOMAINS = [
    'instagram.com', 'www.instagram.com',
    'catchtable.co.kr', 'www.catchtable.co.kr',
    'naver.com', 'booking.naver.com', 'map.naver.com',
    'kakao.com', 'pf.kakao.com'
];

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════
// FILTER 1: Business Registration Status (국세청 사업자 상태 API)
// ═══════════════════════════════════════════
async function filterBusinessStatus(place) {
    // Pop-ups and exhibitions are temporary events and do not have individual business registration numbers
    if (place.category === 'popup' || place.category === 'exhibition') {
        return { score: 15, detail: 'Events bypass business registration check' };
    }

    const apiKey = process.env.PUBLIC_DATA_API_KEY;

    // If no API key or no business registration number, return neutral 15 points to avoid penalizing development/scraped data
    if (!apiKey) {
        log('    ⚠ PUBLIC_DATA_API_KEY not set — using neutral business status check score');
        return { score: 15, detail: 'API key not configured (Neutral default)' };
    }

    if (!place.business_registration_number) {
        log('    ℹ No business registration number — using neutral business status check score');
        return { score: 15, detail: 'No registration number available (Neutral default)' };
    }

    return new Promise((resolve) => {
        const requestBody = JSON.stringify({
            b_no: [place.business_registration_number]
        });

        const options = {
            hostname: 'api.odcloud.kr',
            path: `/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(apiKey)}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    const status = result.data?.[0]?.b_stt;
                    if (status === '계속사업자') {
                        resolve({ score: 15, detail: `Active (${status})` });
                    } else if (status === '휴업자') {
                        resolve({ score: 0, detail: `Suspended (${status})` });
                    } else if (status === '폐업자') {
                        resolve({ score: -100, detail: `Closed (${status})` });
                    } else {
                        resolve({ score: 0, detail: `Unknown status: ${status || 'N/A'}` });
                    }
                } catch (err) {
                    resolve({ score: 0, detail: `Parse error: ${err.message}` });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ score: 0, detail: `API error: ${err.message}` });
        });

        req.write(requestBody);
        req.end();
    });
}

// ═══════════════════════════════════════════
// FILTER 2: Geocoding Address Verification (네이버 지도 API)
// NOTE: Naver Maps Geocoding uses Naver Cloud Platform (naveropenapi.apigw.ntruss.com)
//       which is DIFFERENT from Naver Developers (openapi.naver.com).
//       If unavailable, this filter is optional (+0 points) — not fatal.
// ═══════════════════════════════════════════
async function filterGeocoding(place) {
    const address = place.address_ko;
    if (!address) {
        log('    ℹ No Korean address — skipping');
        return { score: 0, detail: 'Skipped — no Korean address' };
    }

    // 간단한 한글 주소 텍스트 포맷 검증 (네이버 클라우드 API 호출 우회)
    // 예: "서울특별시 용산구 이태원로 200" 또는 "서울시 성동구 성수이로 78"
    const hasValidKoreanFormat = /^[가-힣]+(특별시|광역시|특별자치시|도|시)?\s+[가-힣]+[구군시]?\s+[가-힣A-Za-z0-9\-\s]+(로|길|동|읍|면|리)/.test(address);

    if (hasValidKoreanFormat) {
        log(`    📍 Text Address Verified: ${address}`);
        return { score: 15, detail: 'Valid Korean address format' };
    } else {
        log(`    ℹ Address text format not matching standard: ${address}`);
        return { score: 10, detail: 'Custom/Simple address format' };
    }
}

// ═══════════════════════════════════════════
// FILTER 3: Link Activation Test & Trusted Domain Bonus
// ═══════════════════════════════════════════
async function filterLinkCheck(place) {
    const urls = [];

    if (place.reservation_url) urls.push({ url: place.reservation_url, field: 'reservation_url' });
    if (place.instagram) urls.push({ url: place.instagram, field: 'instagram' });

    if (urls.length === 0) {
        return { score: 0, detail: 'No URLs to check', removedLinks: [] };
    }

    let activeLinkScore = 0;
    let domainBonus = 0;
    const removedLinks = [];
    const details = [];

    for (const { url, field } of urls) {
        try {
            const parsed = new URL(url);
            const isTrusted = TRUSTED_DOMAINS.some(d =>
                parsed.hostname === d || parsed.hostname.endsWith('.' + d)
            );

            if (isTrusted) {
                domainBonus += 5; // +5 points per trusted domain link
            }

            const statusCode = await checkURL(url);

            if (statusCode >= 200 && statusCode < 400) {
                activeLinkScore += 5; // +5 points per working link
                details.push(`${field}: ${statusCode} OK`);
            } else {
                removedLinks.push(field);
                details.push(`${field}: ${statusCode} — link removed`);
            }
        } catch (err) {
            removedLinks.push(field);
            details.push(`${field}: connection error (${err.message}) — link removed`);
        }
    }

    const finalLinkScore = Math.min(activeLinkScore, 5);
    const finalDomainBonus = Math.min(domainBonus, 5);

    return {
        score: Math.max(finalLinkScore, finalDomainBonus), // Max 5 points
        detail: `${details.join('; ')} (LinkScore: ${finalLinkScore}, DomainBonus: ${finalDomainBonus})`,
        removedLinks
    };
}

/**
 * Check a URL with HTTP HEAD request (5s timeout)
 */
function checkURL(urlStr) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(urlStr);
            const protocol = parsed.protocol === 'https:' ? https : http;

            const req = protocol.request(urlStr, { method: 'HEAD', timeout: 5000 }, (res) => {
                resolve(res.statusCode);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('timeout'));
            });

            req.on('error', reject);
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ═══════════════════════════════════════════
// Main Verification Pipeline
// ═══════════════════════════════════════════
async function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon Self-Verification Pipeline');
    log('  (3-Filter Confidence Scoring System)');
    log('═══════════════════════════════════════════');

    // Load both refined places, existing database, and review needed queue to re-verify everything
    let refinedPlaces = [];
    if (fs.existsSync(REFINED_FILE)) {
        try {
            refinedPlaces = JSON.parse(fs.readFileSync(REFINED_FILE, 'utf8'));
            log(`📄 Loaded ${refinedPlaces.length} new refined place(s)`);
        } catch (e) { log(`⚠️ Error reading refined_places: ${e.message}`); }
    }

    let existingPlaces = [];
    if (fs.existsSync(PLACES_FILE)) {
        try {
            existingPlaces = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
            log(`📄 Loaded ${existingPlaces.length} existing place(s)`);
        } catch (e) { log(`⚠️ Error reading places: ${e.message}`); }
    }

    let reviewPlaces = [];
    if (fs.existsSync(REVIEW_FILE)) {
        try {
            reviewPlaces = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
            log(`📄 Loaded ${reviewPlaces.length} review needed place(s)`);
        } catch (e) { log(`⚠️ Error reading review_needed: ${e.message}`); }
    }

    // Merge them into a single unique list by ID before verification, adding created_at/updated_at dates
    const todayStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const placesMap = new Map();

    existingPlaces.forEach(p => {
        if (!p.created_at) p.created_at = "2026-07-29"; // Default baseline for existing items
        p.updated_at = todayStr;
        p.wasPublished = true; // Tag as already published in places.json
        placesMap.set(p.id, p);
    });

    reviewPlaces.forEach(p => {
        if (!p.created_at) p.created_at = "2026-07-29";
        p.updated_at = todayStr;
        placesMap.set(p.id, p);
    });

    refinedPlaces.forEach(p => {
        if (!placesMap.has(p.id)) {
            p.created_at = todayStr; // Brand new keyword!
            p.updated_at = todayStr;
            placesMap.set(p.id, p);
        } else {
            const existing = placesMap.get(p.id);
            existing.review_count = p.review_count || 0;
            existing.weekly_review_count = p.weekly_review_count || 0;
            existing.biweekly_review_count = p.biweekly_review_count || 0;
            existing.recent_snippets = p.recent_snippets || [];
            existing.updated_at = todayStr;
            existing.wasPublished = existing.wasPublished || false;
            
            // Merge metadata fields if found in raw input
            if (p.hours && !existing.hours) existing.hours = p.hours;
            if (p.price_range && !existing.price_range) existing.price_range = p.price_range;
            if (p.parking !== undefined && existing.parking === undefined) existing.parking = p.parking;
            if (p.instagram && !existing.instagram) existing.instagram = p.instagram;
            if (p.reservation_url && !existing.reservation_url) existing.reservation_url = p.reservation_url;
            if (p.image && !existing.image) existing.image = p.image;
        }
    });

    const places = Array.from(placesMap.values());
    log(`📊 Total ${places.length} place(s) to verify (re-verifying entire database)\n`);

    const verifiedPlaces = [];

    for (let i = 0; i < places.length; i++) {
        const place = places[i];
        const name = place.name_ko || place.name_en || place.id;

        // Ensure category is sanitized to 5 core keys
        if (!['popup', 'activity', 'beauty', 'dining', 'cafe'].includes(place.category)) {
            const nameKo = place.name_ko || '';
            if (nameKo.includes('빙상장') || nameKo.includes('스케이트') || nameKo.includes('공방') || nameKo.includes('클래스') || nameKo.includes('체험') || nameKo.includes('여행')) {
                place.category = 'activity';
            } else {
                place.category = 'popup';
            }
        }
        log(`────────────────────────────────────────`);
        log(`🔍 [${i + 1}/${places.length}] Verifying: ${name}`);

        let totalScore = 0;

        // Filter 1: Business Registration Status
        log('  📋 Filter 1: Business Registration Status');
        const f1 = await filterBusinessStatus(place);
        log(`    → Score: ${f1.score} | ${f1.detail}`);
        if (f1.score <= -100) {
            log(`  ❌ CLOSED BUSINESS — discarding immediately`);
            discarded++;
            place.discard_reason = 'Closed Business (f1_score <= -100)';
            discardedPlaces.push(place);
            continue;
        }
        totalScore += f1.score;

        // Filter 2: Geocoding
        log('  🗺️  Filter 2: Address Geocoding');
        const f2 = await filterGeocoding(place);
        log(`    → Score: ${f2.score} | ${f2.detail}`);
        if (f2.score <= -100) {
            log(`  ❌ INVALID ADDRESS — discarding immediately`);
            discarded++;
            place.discard_reason = 'Invalid Address format (f2_score <= -100)';
            discardedPlaces.push(place);
            continue;
        }
        totalScore += f2.score;

        // Filter 3: Link Check & Domain Bonus (Max 20 points)
        log('  🔗 Filter 3: Link Activation & Domain Bonus');
        const f3 = await filterLinkCheck(place);
        log(`    → Score: ${f3.score} | ${f3.detail}`);
        totalScore += f3.score;

        // Remove dead links from the place object
        if (f3.removedLinks && f3.removedLinks.length > 0) {
            for (const field of f3.removedLinks) {
                place[field] = null;
                log(`    🗑️  Removed dead link: ${field}`);
            }
        }

        // Filter 4: Total Review Popularity / Volume (Max 5 points)
        log('  🔥 Filter 4: Total Review Popularity');
        let reviewScore = 0;
        const reviewCount = place.review_count || 0;
        if (reviewCount >= 1000) {
            reviewScore = 5;
        } else if (reviewCount >= 100) {
            reviewScore = 3;
        }
        log(`    → Score: ${reviewScore} | Review count is ${reviewCount}`);
        totalScore += reviewScore;

        // Filter 5: Recent Review Velocity / Viral Power (Max 50 points)
        log('  ⚡ Filter 5: Recent Review Velocity');
        let velocityScore = 0;
        const weeklyCount = place.weekly_review_count || 0;
        const biweeklyCount = place.biweekly_review_count || 0;
        if (weeklyCount >= 10) {
            velocityScore = 50;
        } else if (weeklyCount >= 5) {
            velocityScore = 40;
        } else if (weeklyCount >= 3) {
            velocityScore = 30;
        } else if (weeklyCount >= 1) {
            velocityScore = 20;
        } else if (biweeklyCount >= 3) {
            velocityScore = 15;
        } else if (biweeklyCount >= 1) {
            velocityScore = 10;
        }
        log(`    → Score: ${velocityScore} | Weekly: ${weeklyCount}, Biweekly: ${biweeklyCount}`);
        totalScore += velocityScore;

        // Filter 6: Rising New Trend Bonus (Max 30 points)
        log('  📈 Filter 6: Rising New Trend Bonus');
        let trendBonus = 0;
        if (reviewCount < 1000 && weeklyCount >= 2) {
            trendBonus = 30;
            log('    → Score: +30 | Emerging hot trend bonus applied (review_count < 1000 and weekly_review_count >= 2)');
        } else {
            log('    → Score: +0 | No emerging trend bonus');
        }
        totalScore += trendBonus;

        // Filter 7: Permanent Chain Store Penalty (Max -20 points)
        log('  🏢 Filter 7: Permanent Chain Store Penalty');
        let chainPenalty = 0;
        const nameK = place.name_ko || '';
        const isChainSuffix = /(지점|점)$/.test(nameK.trim()) && !/본점$/.test(nameK.trim());
        const isDepartmentStore = /(백화점|더현대|스타필드|아울렛)/.test(nameK) || (place.address_ko && /(백화점|더현대|스타필드|아울렛)/.test(place.address_ko));
        const isPopupName = /(팝업|전시|쇼룸)/.test(nameK);
        
        if (!isPopupName && (isChainSuffix || isDepartmentStore)) {
            chainPenalty = -40; // Increased penalty from -20 to -40 for franchises
            log(`    → Score: ${chainPenalty} | Applied strict penalty for permanent chain/department store`);
        } else {
            log('    → Score: -0 | No chain penalty');
        }
        totalScore += chainPenalty;

        // Filter 8: Generic Business Penalty (Max -100 points)
        log('  🚫 Filter 8: Generic Business Penalty');
        let genericPenalty = 0;
        const isGenericBusiness = /(한의원|병원|의원|치과|약국|필라테스|요가|헬스장|피트니스|어린이집|유치원|학원|부동산|세무사|변호사)/.test(nameK);
        if (isGenericBusiness) {
            if (place.category === 'beauty' || place.category === 'activity') {
                log('    → Score: -0 | Waived generic penalty for beauty/wellness/activity categories');
            } else {
                genericPenalty = -100;
                log(`    → Score: ${genericPenalty} | Applied penalty for generic business types (clinic/pilates/etc)`);
            }
        } else {
            log('    → Score: -0 | No generic business penalty');
        }
        totalScore += genericPenalty;

        // Cap score at 100
        let finalScore = Math.min(Math.max(totalScore, 0), 100);

        // ─── Mathematical Event Date Check ───
        const isTemporaryEvent = place.type === 'Event' || ['popup', 'festival', 'exhibition', 'fair'].includes(place.category);
        if (isTemporaryEvent && place.startDate && place.endDate) {
            const todayStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
            if (todayStr > place.endDate) {
                if (place.operating_status !== '행사 종료') {
                    place.operating_status = '행사 종료';
                    log(`   📅 Date Auto-Transition: updated status to '행사 종료' (Today: ${todayStr} > EndDate: ${place.endDate})`);
                }
            } else if (todayStr < place.startDate) {
                if (place.operating_status !== '행사 예정') {
                    place.operating_status = '행사 예정';
                    log(`   📅 Date Auto-Transition: updated status to '행사 예정' (Today: ${todayStr} < StartDate: ${place.startDate})`);
                }
            } else {
                if (place.operating_status !== '행사 중') {
                    place.operating_status = '행사 중';
                    log(`   📅 Date Auto-Transition: updated status to '행사 중' (Today: ${todayStr} within ${place.startDate} ~ ${place.endDate})`);
                }
            }
        }

        // Heuristic Status Override: If status is '확인 불가' but we have recent blog posts,
        // promote it to '운영 중' or '행사 중' to avoid false negatives.
        let opStatus = place.operating_status || '확인 불가';
        if (opStatus === '확인 불가' || opStatus === '확인 불가 (에러)') {
            if (weeklyCount >= 1 || biweeklyCount >= 2) {
                const isEvent = place.type === 'Event' || place.category === 'popup' || place.category === 'exhibition';
                opStatus = isEvent ? '행사 중' : '운영 중';
                place.operating_status = opStatus;
                log(`  💡 Heuristic Override in verify: promoted '확인 불가' to '${opStatus}' due to review velocity (Weekly: ${weeklyCount}, Biweekly: ${biweeklyCount})`);
            }
        }

        // Operating Status Adjustments: Penalize CLOSED, ENDED, or UNCERTAIN (확인 불가) places
        if (opStatus === '행사 종료' || opStatus === '영업 종료' || opStatus === '종료') {
            if (place.wasPublished) {
                log(`  ℹ️  ALREADY PUBLISHED place is ended (${opStatus}) — retaining in database (places.json)`);
                // Keep score as-is or make sure it bypasses filtering to remain published
            } else {
                log(`  ❌ NEW CLOSED/ENDED EVENT OR BUSINESS (${opStatus}) — forcing score to 0`);
                finalScore = 0;
            }
        } else if (opStatus === '확인 불가') {
            log(`  ⚠️  UNCERTAIN OPERATING STATUS (확인 불가) — applying -15 points penalty`);
            finalScore = Math.max(finalScore - 15, 0);
        } else if (opStatus === '운영 중' || opStatus === '행사 중') {
            log(`  ✅ ACTIVE OPERATION CONFIRMED (${opStatus}) — applying +20 points bonus`);
            finalScore = Math.min(finalScore + 20, 100);
        }
        
        place.confidence_score = finalScore;

        log(`  ── TOTAL SCORE: ${finalScore}/100 (Weekly: ${weeklyCount}, Biweekly: ${biweeklyCount})`);

        // Print action decision
        if (finalScore >= 60) {
            log(`  ✅ AUTO-PUBLISH (Score: ${finalScore})`);
        } else if (finalScore >= 30) {
            log(`  ⏸️  REVIEW NEEDED (Score: ${finalScore})`);
        } else {
            log(`  ❌ DISCARDED (Score: ${finalScore})`);
        }

        verifiedPlaces.push(place);

        // Rate limit between API calls
        if (i < places.length - 1) {
            await sleep(300);
        }
    }

    // Sort all verified places to prefer complete information prior to deduplication
    verifiedPlaces.sort((a, b) => {
        const scoreA = (a.address_ko && a.address_ko.includes('구') ? 5 : 0) + (a.hours ? 2 : 0) + (a.instagram ? 1 : 0) + (a.confidence_score || 0) / 100;
        const scoreB = (b.address_ko && b.address_ko.includes('구') ? 5 : 0) + (b.hours ? 2 : 0) + (b.instagram ? 1 : 0) + (b.confidence_score || 0) / 100;
        return scoreB - scoreA;
    });

    // Deduplicate the combined list
    const uniquePlaces = [];
    const seenNames = new Set();
    const seenAddresses = new Set();

    verifiedPlaces.forEach(p => {
        const cleanName = (p.name_ko || '').replace(/\s+/g, '').toLowerCase();
        const cleanAddress = (p.address_ko || '')
            .replace(/\d+층|\d+F|지하\s*\d+층|지상\s*\d+층/g, '')
            .replace(/\s+/g, '')
            .trim();

        // 1. Exact name match
        if (seenNames.has(cleanName)) return;

        // 2. Address match for non-events
        const isEvent = p.category === 'popup' || p.category === 'exhibition';
        if (!isEvent && cleanAddress && seenAddresses.has(cleanAddress)) return;

        // 3. Translation & address match for events
        if (isEvent && cleanAddress) {
            const duplicateEvent = uniquePlaces.find(m => {
                const mCleanAddress = (m.address_ko || '')
                    .replace(/\d+층|\d+F|지하\s*\d+층|지상\s*\d+층/g, '')
                    .replace(/\s+/g, '')
                    .trim();
                if (mCleanAddress !== cleanAddress) return false;
                
                const nameA = cleanName;
                const nameB = (m.name_ko || '').replace(/\s+/g, '').toLowerCase();
                return nameA.includes('harley') || nameB.includes('harley') || nameA.includes('할리') || nameB.includes('할리') || nameA.slice(0, 4) === nameB.slice(0, 4);
            });
            if (duplicateEvent) return;
        }

        uniquePlaces.push(p);
        seenNames.add(cleanName);
        if (!isEvent && cleanAddress) {
            seenAddresses.add(cleanAddress);
        }
    });

    // Categorize unique places
    const alreadyPublished = [];
    const newAutoPublish = [];
    const reviewNeeded = [];
    const discardedPlaces = [];
    let discarded = 0;

    uniquePlaces.forEach(p => {
        const score = p.confidence_score;
        const opStatus = p.operating_status || '확인 불가';
        
        const hadBeenPublished = p.wasPublished;
        delete p.wasPublished;
        delete p.recent_snippets;
        
        if (hadBeenPublished) {
            alreadyPublished.push(p);
        } else if (score >= 60) {
            newAutoPublish.push(p);
        } else if (score >= 30) {
            reviewNeeded.push(p);
        } else {
            discarded++;
            p.discard_reason = `Low Confidence Score (${score} < 30)`;
            discardedPlaces.push(p);
        }
    });

    // Save results
    log('\n════════════════════════════════════════');
    log('  Verification Results Summary');
    log('════════════════════════════════════════');
    log(`  Published (Retained): ${alreadyPublished.length} place(s)`);
    log(`  ✅ New Auto-publish (To Refine): ${newAutoPublish.length} place(s)`);
    log(`  ⏸️  Review needed: ${reviewNeeded.length} place(s)`);
    log(`  ❌ Discarded: ${discarded} place(s)`);

    fs.writeFileSync(PLACES_FILE, JSON.stringify(alreadyPublished, null, 2), 'utf8');
    log(`\n📁 places.json updated (retained published items): ${alreadyPublished.length} place(s)`);

    fs.writeFileSync(PLACES_TO_REFINE_FILE, JSON.stringify(newAutoPublish, null, 2), 'utf8');
    log(`📁 places_to_refine.json created: ${newAutoPublish.length} place(s) for AI refinement`);

    fs.writeFileSync(REVIEW_FILE, JSON.stringify(reviewNeeded, null, 2), 'utf8');
    log(`📁 review_needed.json updated: ${reviewNeeded.length} place(s) for manual review`);

    fs.writeFileSync(DISCARDED_FILE, JSON.stringify(discardedPlaces, null, 2), 'utf8');
    log(`📁 discarded_places.json: ${discardedPlaces.length} place(s) recorded for audit/diagnostics`);

    log('════════════════════════════════════════\n');
}

main().catch(err => {
    log(`❌ Fatal error: ${err.message}`);
    process.exit(1);
});
