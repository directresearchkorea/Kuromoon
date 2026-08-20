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
    if (cleanName.length >= 6 || cleanName.includes('??) || cleanName.includes('지??)) {
        return cleanName;
    }
    
    let region = '';
    if (address) {
        // Clean parentheses to extract inner Dong names like (?�수??가) -> ?�수??가
        const cleanAddr = address.replace(/[()]/g, ' ');
        const parts = cleanAddr.split(/\s+/);
        // 1. Try to find a word ending with '?? (e.g., ?�수?? ?�선??
        let found = parts.find(p => p.endsWith('??));
        // 2. Try to find a word ending with '�? (e.g., 종로�? 강남�?
        if (!found) found = parts.find(p => p.endsWith('�?));
        // 3. Try to find a word ending with '?? (but exclude metropolitan cities like ?�울?�별??
        if (!found) {
            found = parts.find(p => p.endsWith('??) && !p.includes('?�별') && !p.includes('광역'));
        }
        if (found) {
            region = found + ' ';
        }
    }
    
    let suffix = '';
    if (cleanName.length <= 3) {
        const suffixMap = {
            popup: '?�업',
            activity: '공방',
            beauty: '?�니??,
            dining: '맛집',
            cafe: '카페'
        };
        suffix = ' ' + (suffixMap[category] || '');
    }
    
    return `${region}${cleanName}${suffix}`.trim();
}

/**
 * Call Naver Local Search API to find registered businesses (Map-based)
 */
function searchNaverLocal(query) {
    return new Promise((resolve, reject) => {
        if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
            return reject(new Error('Naver client keys not configured'));
        }
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/local.json?query=${encodeURIComponent(query)}&display=15&sort=comment`,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
            }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Local Search API returned ${res.statusCode}: ${data.substring(0, 200)}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Call Naver Blog Search API
 */
function searchNaverBlog(query, display = 4, sort = 'sim') {
    return new Promise((resolve, reject) => {
        if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
            return reject(new Error('Naver client keys not configured'));
        }
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
            }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Blog Search API returned ${res.statusCode}: ${data.substring(0, 200)}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}


/**
 * Call Gemini AI to extract venue and address from blog snippets
 */
function extractVenueAndAddressWithAI(keyword, snippets) {
    return new Promise((resolve) => {
        if (!process.env.GEMINI_API_KEY) {
            log('   ?�️ GEMINI_API_KEY not configured ??skipping AI venue resolution');
            return resolve({ success: false });
        }
        
        const prompt = `?�신?� 블로�?글?�서 ?�사/?�업?�토?��? ?�리???�제 ?�소명과 ?�로�?주소�?추출?�는 ?�이???�문가?�니??
?�워?? '${keyword}'

?�음?� ???�워?�에 ?�??최근 블로�?리뷰 ?�용?�입?�다.
글??분석?�여 ???�업?�토???�사가 개최??**?�제 ?�소(건물�? 백화??지????**?� **?�로�?주소**�?찾아주세??

## 추출 기�?:
1. ?�로�?주소(?? ?�울?�별???�등?�구 ?�의?��?108)가 명시?�어 ?�거?? 개최 ?�소(?? ?�현?� ?�울 5�?�??�해 주소�?명확???�추?????�다�??�당 주소�?출력?�세??
2. 만약 개최 ?�소�??�오�?주소가 직접 ???�온?�면, ???�려�??�소(?? ?�현?� ?�울, AK?�라???��?, 무신???�토???�수 ????경우 ?�당 ?�소???��? 주소�??�어주세??
3. 개최 ?�소??주소�??��? ?????�다�?null??반환?�세??

출력 ?�식?� 반드???�래 JSON ?�식?�로�??��??�세??(?�른 ?�명?�나 마크?�운 백틱 ?�이 JSON 블록�?출력):
{
  "venue": "개최 ?�소�?(?? ?�현?� ?�울 ?�픽 ?�울)",
  "address": "?�로�?주소 (?? ?�울?�별???�등?�구 ?�의?��?108)",
  "success": true ?�는 false
}

블로�??�약�?
${snippets.map((s, i) => `[글 ${i + 1}]\n${s}`).join('\n\n')}
`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1000
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.candidates && parsed.candidates.length > 0) {
                        const text = parsed.candidates[0].content.parts[0].text.trim();
                        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                        resolve(JSON.parse(cleaned));
                    } else {
                        resolve({ success: false });
                    }
                } catch (e) {
                    resolve({ success: false });
                }
            });
        });
        req.on('error', () => resolve({ success: false }));
        req.write(requestBody);
        req.end();
    });
}


/**
 * Clean up a composite keyword using Gemini AI to extract a search-friendly query for Naver Maps Local Search.
 */
function getCleanMapSearchQuery(keyword) {
    return new Promise((resolve) => {
        if (!process.env.GEMINI_API_KEY) {
            return resolve(keyword);
        }
        
        const prompt = `?�신?� ?�용?��? ?�력???�렌??복합 ?�워?�에???�이�?지??Naver Maps Local Search)??검?�하�?가??좋�? '?�제 ?�호�?+ 지??��' 검?�어�??�제?�내???�이???�문가?�니??

## ?�업 가?�드:
1. ?�워?�에???�질?�인 ?�점/?�사???�시???�름(?�호�???추출?�세??
2. ?�호�??�뒤??붙�? 불필?�한 ?�식??�?검???�워???? "?�옥 ?�??, "?�전 ?�식", "?�화 감성", "?�래??, "체험 코스", "분위�?좋�?", "맛집", "카페 추천", "추천")???�거?�세??
3. [매우 중요] 만약 ?�워?��? '?�업?�토????'?�시' ???�관 ?�사??경우, ?�사가 ?�리??'?�제 ?�관 ?�소�?건물�?(?? ?�상비일?�의?? ?�현?� ?�울, ?�스?�토�? ?�퀘어, �?��?�드�??????�워?�나 문맥???�함?�어 ?�다�??��? 'host_venue'�?별도 추출?�세??
4. ?�이�?지??API???�업?�토???�름??모�? ???�습?�다. ?�라??host_venue가 존재?�다�??�이�?지??검?�어??host_venue�?1?�위�??�용?�니??
5. ?�시:
   - "?�상비일?�의??story A ?�업" -> name: "story A", host_venue: "?�상비일?�의??, search_query: "?�상비일?�의??
   - "?�현?� ?�울 ?�올 ?�업" -> name: "?�올", host_venue: "?�현?� ?�울", search_query: "?�현?� ?�울"
   - "?�선반주 ?�옥 ?�이?? -> name: "?�선반주", host_venue: "", search_query: "?�선반주 ?�선??

출력 ?�식?� 반드???�래 JSON ?�식?�로�??��??�세??(?�른 ?�명?�나 마크?�운 백틱 ?�이 JSON 블록�?출력):
{
  "name": "?�호�?,
  "host_venue": "?�관?�소�??�는 �?문자??,
  "search_query": "?�이�?지??검?�어"
}
`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt + `\n\n?�력 ?�워?? "${keyword}"` }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1000
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.candidates && parsed.candidates.length > 0) {
                        const text = parsed.candidates[0].content.parts[0].text.trim();
                        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                        const parsedJson = JSON.parse(cleaned);
                        resolve(parsedJson.search_query || keyword);
                    } else {
                        resolve(keyword);
                    }
                } catch (e) {
                    resolve(keyword);
                }
            });
        });
        req.on('error', () => resolve(keyword));
        req.write(requestBody);
        req.end();
    });
}


async function main() {
    log('?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═??);
    log('  Kuromoon Map-First & Custom Collector');
    log('?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═??);

    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
        log('??ERROR: NAVER_CLIENT_ID or NAVER_CLIENT_SECRET is not configured in .env');
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
                            popup: '?�업?�토???�시',
                            beauty: 'K-뷰티/?��?관�?,
                            dining: '?�치 ?�이??,
                            cafe: '콘셉??카페'
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
        return addr.replace(/^(?�울?�별???�울???�울|부?�광??��|부?�시|부??\s+/, '')
                   .replace(/\s+(\d+�?지??*|.*???�엠블루.*|?�업.*)$/, '')
                   .replace(/\s+/g, '')
                   .toLowerCase();
    }

    function findExistingPlace(name, address) {
        const cleanN = name.replace(/\s+/g, '').toLowerCase();
        const cleanAddr = address ? address.replace(/\s+/g, '').toLowerCase() : '';
        const nAddr = normAddr(address);
        
        const allPlaces = [...existingPlaces, ...reviewPlaces];

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
                    .replace(/[^\w\s가-??]/g, '')
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
                    const isGeneric = /(?�의??병원|?�원|치과|?�국|?�라?�스|?��?|?�스???�트?�스|?�린?�집|?�치???�원|부?�산|?�무??변?�사)/.test(pName);
                    const isFranchiseBranch = /(지????$/.test(pName.trim()) && !/본점$/.test(pName.trim());
                    
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
                        .replace(/[^\w\s가-??]/g, '')
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
    log('?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═?�═??n');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
