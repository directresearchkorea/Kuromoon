const fs = require('fs');
const path = require('path');
const https = require('https');

// Load environment variables
const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const TRENDS_FILE = path.join(DATA_DIR, 'trending_keywords.json');
const CUSTOM_KEYWORDS_FILE = path.join(DATA_DIR, 'custom_keywords.json');
const PLACES_FILE = path.join(DATA_DIR, 'places.json');
const REVIEW_FILE = path.join(DATA_DIR, 'review_needed.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'raw_inputs.json');

const envPath = path.join(WEB_DIR, '.env');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^#\s][^=]+)=(.*)$/);
        if (match) {
            process.env[match[1].trim()] = match[2].trim();
        }
    });
}

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clean HTML bold tags and escape entities
 */
function cleanHtml(str) {
    if (!str) return '';
    return str
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Create a highly specific blog search query using Name + City/Gu/Dong to avoid generic word overlap
 */
function getPreciseQuery(placeName, address, category) {
    const cleanName = placeName.trim();
    if (cleanName.length >= 6 || cleanName.includes('팝업') || cleanName.includes('지점')) {
        return cleanName;
    }
    
    let region = '';
    if (address) {
        const cleanAddr = address.replace(/[()]/g, ' ');
        const parts = cleanAddr.split(/\s+/);
        let found = parts.find(p => p.endsWith('동'));
        if (!found) found = parts.find(p => p.endsWith('구'));
        if (!found) {
            found = parts.find(p => p.endsWith('시') && !p.includes('특별') && !p.includes('광역'));
        }
        if (found) {
            region = found + ' ';
        }
    }
    
    let suffix = '';
    if (cleanName.length <= 3) {
        const suffixMap = {
            popup: '팝업',
            activity: '공방',
            beauty: '미용실',
            medical: '피부과',
            dining: '식당',
            cafe: '카페'
        };
        if (suffixMap[category]) suffix = ' ' + suffixMap[category];
    }
    
    return region + cleanName + suffix;
}

async function main() {
    log('===========================================');
    log('  Kuromoon Map-First & Custom Collector');
    log('===========================================');

    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    log('===========================================');
        process.exit(1);
    }

    // 2. Load Trend Keywords
    let trendsData = { categories: {} };
    if (fs.existsSync(TRENDS_FILE)) {
        try {
            trendsData = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf8'));
        } catch (e) {
            log(`??Warning: Failed to parse trending_keywords.json: ${e.message}`);
        }
    }

    const categories = trendsData.categories || {};
    const allKeywords = [];
    for (const [catKey, catVal] of Object.entries(categories)) {
        const keywords = catVal.trending_keywords || [];
        keywords.forEach(kwObj => {
            allKeywords.push({
                keyword: kwObj.keyword,
                category: catKey,
                label: catVal.label,
                trend_score: kwObj.trend_score || 0
            });
        });
    }

    // Sort trends globally by score
    allKeywords.sort((a, b) => b.trend_score - a.trend_score);

    // Filter keywords by trend score threshold (trend_score >= 0 to process all discovered items)
    const SCORE_THRESHOLD = 0;
    const targetKeywords = allKeywords.filter(kwObj => (kwObj.trend_score || 0) >= SCORE_THRESHOLD);

    if (targetKeywords.length === 0) {
        log(`??No keywords met the threshold score >= ${SCORE_THRESHOLD}. Falling back to top 5 keywords overall.`);
        targetKeywords.push(...allKeywords.slice(0, 5));
    }

    // Load custom keywords if the file exists
    let customKeywords = [];
    if (fs.existsSync(CUSTOM_KEYWORDS_FILE)) {
        try {
            const rawCustom = JSON.parse(fs.readFileSync(CUSTOM_KEYWORDS_FILE, 'utf8'));
            if (Array.isArray(rawCustom)) {
                rawCustom.forEach(item => {
                    if (typeof item === 'string') {
                        customKeywords.push({
                            keyword: item.trim(),
                            category: 'popup', // default
                            label: '?�업?�토???�시',
                            trend_score: 100 // High priority
                        });
                    } else if (item && typeof item === 'object' && item.keyword) {
                        const catLabels = {
                            popup: '팝업스토어/전시',
                            beauty: 'K-뷰티/체형관리',
                            dining: '이색 다이닝',
                            cafe: '콘셉트 카페',
                            activity: '이색 체험'
                        };
                        customKeywords.push({
                            keyword: item.keyword.trim(),
                            category: item.category || 'popup',
                            label: catLabels[item.category] || '?�업?�토???�시',
                            trend_score: 100 // High priority
                        });
                    }
                });
                log(`?�� Loaded ${customKeywords.length} custom keyword(s) from custom_keywords.json`);
            }
        } catch (e) {
            log(`??Failed to parse custom_keywords.json: ${e.message}`);
        }
    }

    // Append custom keywords and deduplicate
    customKeywords.forEach(ckw => {
        const duplicate = targetKeywords.find(tkw => tkw.keyword.toLowerCase() === ckw.keyword.toLowerCase());
        if (!duplicate) {
            targetKeywords.push(ckw);
        } else {
            // Upgrade trend score if it's already there
            duplicate.trend_score = Math.max(duplicate.trend_score, ckw.trend_score);
        }
    });

    log(`?? Total ${targetKeywords.length} keywords scheduled for map-first extraction.`);

    // Load existing databases
    let existingPlaces = [];
    if (fs.existsSync(PLACES_FILE)) {
        try { existingPlaces = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')); } catch (e) {}
    }
    let reviewPlaces = [];
    if (fs.existsSync(REVIEW_FILE)) {
        try { reviewPlaces = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')); } catch (e) {}
    }

    function getJaccard(s1, s2) {
        if (!s1 || !s2) return 0;
        const a = s1.replace(/\s+/g, '').toLowerCase();
        const b = s2.replace(/\s+/g, '').toLowerCase();
        const getBigrams = s => {
            let bg = new Set();
            for(let i=0; i<s.length-1; i++) bg.add(s.substring(i, i+2));
            return bg;
        };
        const b1 = getBigrams(a), b2 = getBigrams(b);
        let intersection = 0;
        for (const x of b1) if (b2.has(x)) intersection++;
        const union = b1.size + b2.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    function normAddr(addr) {
        if (!addr) return '';
        return addr.replace(/^(서울특별시|서울시|서울|부산광역시|부산시|부산)\s+/, '')
                   .replace(/\s+/g, '')
                   .toLowerCase();
    }


    function findExistingPlace(name, address) {
        const cleanN = name.replace(/\s+/g, '').toLowerCase();
        const cleanAddr = address ? address.replace(/\s+/g, '').toLowerCase() : '';
        const nAddr = normAddr(address);
        
        const allPlaces = [...existingPlaces, ...reviewPlaces, ...discardedPlaces, ...refinePlaces];

        // 1. Exact name match
        let found = allPlaces.find(p => p.name_ko.replace(/\s+/g, '').toLowerCase() === cleanN);
        if (found) return found;

        // 2. Exact address match for NON-popups
        if (cleanAddr) {
            found = allPlaces.find(p => p.category !== 'popup' && p.category !== 'exhibition' && p.address_ko && p.address_ko.replace(/\s+/g, '').toLowerCase() === cleanAddr);
            if (found) return found;
        }

        // 3. Smart similarity match for popups (Same normalized address + Name Similarity > 0.15)
        if (nAddr) {
            found = allPlaces.find(p => {
                if (p.category !== 'popup' && p.category !== 'exhibition') return false;
                if (!p.address_ko || normAddr(p.address_ko) !== nAddr) return false;
                return getJaccard(name, p.name_ko) > 0.15;
            });
            if (found) return found;
        }

        return null;
    }

    const rawInputs = [];

    // 3. Loop through keywords and perform Map-First Search
    for (const kwObj of targetKeywords) {
        let kw = kwObj.keyword;
        let pureName = kw;
        let region = '';
        
        if (kw.includes('|')) {
            const parts = kw.split('|');
            pureName = parts[0].trim();
            region = parts[1].trim();
            if (region === '미상') region = '';
        }

        const catKey = kwObj.category;
        const catLabel = kwObj.label;

        log(`\n?�� [Keyword] Processing: "${pureName}" (Region: ${region || 'None'}, Category: ${catLabel}, Score: ${kwObj.trend_score})`);

        try {
            // Step A: Search Naver Maps (Local Search)
            let searchQuery = region ? `${region} ${pureName}` : pureName;
            log(`   ?���?Querying Naver Local Map with: "${searchQuery}"`);
            let localResults = await searchNaverLocal(searchQuery);
            let places = localResults.items || [];

            if (places.length === 0) {
                log(`   ??No map results with targeted query. Falling back to pure name...`);
                localResults = await searchNaverLocal(pureName);
                places = localResults.items || [];
            }

            if (places.length === 0) {
                log(`   ??Still no results. Cleaning up pure name using AI...`);
                const cleanQuery = await getCleanMapSearchQuery(pureName);
                if (cleanQuery && cleanQuery !== pureName) {
                    log(`   ?�� AI cleaned query: "${pureName}" -> "${cleanQuery}"`);
                    const fallbackLocalResults = await searchNaverLocal(region ? `${region} ${cleanQuery}` : cleanQuery);
                    places = fallbackLocalResults.items || [];
                    
                    if (places.length === 0) {
                        const pureFallback = await searchNaverLocal(cleanQuery);
                        places = pureFallback.items || [];
                    }
                }
            }

            // [NEW] Host Venue Fallback for Popups
            if (places.length === 0 && region && (catKey === 'popup' || catKey === 'exhibition')) {
                log(`   ?�� Popup not found on map! Falling back to map the Host Venue (Region): "${region}"`);
                const venueResults = await searchNaverLocal(region);
                if (venueResults.items && venueResults.items.length > 0) {
                    places = [venueResults.items[0]]; // Map to the host venue!
                    places[0].title = pureName; // Override title to be the popup name, but keep host address!
                    log(`   ??Successfully mapped to Host Venue: ${venueResults.items[0].roadAddress}`);
                }
            }

            if (places.length === 0) {
                log(`   ?�️ No map results. Skipping AI address extraction to prevent phantom places.`);
                
                const id = pureName.toLowerCase()
                    .replace(/[^\w\s가-힣]/g, '')
                    .replace(/\s+/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '')
                    .substring(0, 60);

                rawInputs.push({
                    id: id,
                    name_ko: pureName,
                    address_ko: '',
                    category: catKey,
                    source_text: '',
                    is_already_refined: false,
                    existing_place_data: null,
                    review_count: 0,
                    weekly_review_count: 0,
                    biweekly_review_count: 0,
                    recent_snippets: [],
                    confidence_score: Math.max(0, score - 50),
                    operating_status: '보류'
                });
                continue;
            }

            if (places.length > 0) {
                // Filter out generic businesses and franchises to not waste slots
                places = places.filter(p => {
                    const pName = cleanHtml(p.title);
                    const isGeneric = /(한의원|병원|의원|치과|약국|필라테스|요가|헬스장|피트니스|어린이집|유치원|학원|부동산|세무사|변호사)/.test(pName);
                    const isFranchiseBranch = /(지점|점)$/.test(pName.trim()) && !/본점$/.test(pName.trim());
                    
                    if (isGeneric) {
                        return (catKey === 'beauty' || catKey === 'activity');
                    }
                    if (isFranchiseBranch) {
                        return false; // Always drop franchise branches from map results
                    }
                    return true;
                });

                const maxPlacesToProcess = Math.min(places.length, 1);
                log(`   ??Discovered ${places.length} matching places on Naver Maps after filtering. (Processing top ${maxPlacesToProcess})`);

                for (let idx = 0; idx < maxPlacesToProcess; idx++) {
                    const place = places[idx];
                    const placeName = cleanHtml(place.title);
                    const roadAddress = place.roadAddress || place.address || '';
                    
                    if (!placeName) continue;

                    log(`      ?�� Place ${idx + 1}: "${placeName}" (${roadAddress})`);

                    // Step B: Search Naver Blogs for this specific place
                    const preciseQuery = getPreciseQuery(placeName, roadAddress, catKey);
                    log(`         ?�� Searching reviews for "${placeName}" using precise query: "${preciseQuery}"...`);
                    
                    // Fetch both relevant and newest reviews
                    const blogSim = await searchNaverBlog(preciseQuery, 4, 'sim');
                    const blogDate = await searchNaverBlog(preciseQuery, 30, 'date');
                    
                    const reviewCount = blogDate.total || 0;
                    log(`         - Total Reviews Found: ${reviewCount}`);

                    // Calculate Weekly Review Velocity
                    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
                    const sevenDaysAgo = new Date(nowKst.getTime() - 7 * 24 * 60 * 60 * 1000);
                    const fourteenDaysAgo = new Date(nowKst.getTime() - 14 * 24 * 60 * 60 * 1000);

                    let weeklyCount = 0;
                    let biweeklyCount = 0;

                    (blogDate.items || []).forEach(item => {
                        const dateStr = item.postdate; // format: "YYYYMMDD"
                        if (dateStr && dateStr.length === 8) {
                            const y = parseInt(dateStr.substring(0, 4));
                            const m = parseInt(dateStr.substring(4, 6)) - 1;
                            const d = parseInt(dateStr.substring(6, 8));
                            const postDate = new Date(y, m, d);
                            
                            if (postDate >= sevenDaysAgo) {
                                weeklyCount++;
                            }
                            if (postDate >= fourteenDaysAgo) {
                                biweeklyCount++;
                            }
                        }
                    });
                    log(`         - Weekly Reviews: ${weeklyCount}, Biweekly Reviews: ${biweeklyCount}`);

                    // Pre-filtering: skip if reviewCount === 0 (no blog posts at all)
                    // or if it has 0 recent velocity and no custom keyword.
                    const isCustom = customKeywords.some(ckw => ckw.keyword.toLowerCase() === pureName.toLowerCase());
                    if (!isCustom && weeklyCount === 0 && biweeklyCount === 0 && reviewCount === 0) {
                        log(`         ??Skipping "${placeName}" because it has 0 reviews.`);
                        continue;
                    }

                    // Collect top 4 snippets for crawler operating status check
                    const recentItems = (blogDate.items || []).slice(0, 4);
                    const snippets = recentItems.map(item => cleanHtml(item.description));

                    const blogItems = [];
                    const seenLinks = new Set();

                    if (blogSim.items && blogSim.items.length > 0) {
                        const firstSim = blogSim.items[0];
                        blogItems.push(firstSim);
                        seenLinks.add(firstSim.link);
                    }

                    if (blogDate.items && blogDate.items.length > 0) {
                        const firstDate = blogDate.items.find(item => !seenLinks.has(item.link));
                        if (firstDate) {
                            blogItems.push(firstDate);
                            seenLinks.add(firstDate.link);
                        } else if (blogItems.length === 0) {
                            blogItems.push(blogDate.items[0]);
                        }
                    }

                    if (blogItems.length === 0) {
                        log(`         ??No blog reviews found for this specific place.`);
                        continue;
                    }

                    // Format reviews for Gemini parser
                    const reviewTexts = blogItems.map((item, bIdx) => {
                        const cleanTitle = cleanHtml(item.title);
                        const cleanDesc = cleanHtml(item.description);
                        return `[리뷰 ${bIdx + 1}]\n?�목: ${cleanTitle}\n?�용: ${cleanDesc}`;
                    }).join('\n\n');

                    // Inject Naver Map names & addresses directly so Gemini is guaranteed to output correct data
                    const sourceText = `검???�워?? ${kw}
?�제 지???�호�? ${placeName}
?�제 지???�로�?주소: ${roadAddress}
카테고리: ${catLabel || catKey}

${reviewTexts}`;

                    // Generate ID
                    const id = placeName.toLowerCase()
                        .replace(/[^\w\s가-힣]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-|-$/g, '')
                        .substring(0, 60);

                    // Check duplicate / existing
                    const existingPlace = findExistingPlace(placeName, roadAddress);
                    if (existingPlace) {
                        log(`         ?�️  Already in database: "${existingPlace.name_ko}" ??marked to skip refine.`);
                        rawInputs.push({
                            id: id,
                            name_ko: placeName,
                            address_ko: roadAddress,
                            category: catKey,
                            source_text: sourceText,
                            is_already_refined: true,
                            existing_place_data: existingPlace,
                            review_count: reviewCount,
                            weekly_review_count: weeklyCount,
                            biweekly_review_count: biweeklyCount,
                            recent_snippets: snippets
                        });
                    } else {
                        rawInputs.push({
                            id: id,
                            name_ko: placeName,
                            address_ko: roadAddress,
                            category: catKey,
                            source_text: sourceText,
                            is_already_refined: false,
                            review_count: reviewCount,
                            weekly_review_count: weeklyCount,
                            biweekly_review_count: biweeklyCount,
                            recent_snippets: snippets
                        });
                    }

                    await sleep(300); // Prevent local rate limit
                }
            } else {
                log(`   ??No map results. Skipping direct blog search to prevent phantom places.`);
            }
        } catch (err) {
            log(`   ??Failed to process keyword "${kw}": ${err.message}`);
        }

        await sleep(500); // Rate limit between keywords
    }

    if (rawInputs.length === 0) {
        log('\n?�️ Warning: No raw inputs collected. Preserving existing raw_inputs.json if any.');
        return;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(rawInputs, null, 2), 'utf8');
    log(`\n??Completed! Saved ${rawInputs.length} new raw inputs to raw_inputs.json`);
    log('===========================================');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
