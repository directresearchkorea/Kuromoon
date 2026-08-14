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
    if (cleanName.length >= 6 || cleanName.includes('점') || cleanName.includes('지점')) {
        return cleanName;
    }
    
    let region = '';
    if (address) {
        // Clean parentheses to extract inner Dong names like (성수동1가) -> 성수동1가
        const cleanAddr = address.replace(/[()]/g, ' ');
        const parts = cleanAddr.split(/\s+/);
        // 1. Try to find a word ending with '동' (e.g., 성수동, 익선동)
        let found = parts.find(p => p.endsWith('동'));
        // 2. Try to find a word ending with '구' (e.g., 종로구, 강남구)
        if (!found) found = parts.find(p => p.endsWith('구'));
        // 3. Try to find a word ending with '시' (but exclude metropolitan cities like 서울특별시)
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
            beauty: '웰니스',
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
            path: `/v1/search/local.json?query=${encodeURIComponent(query)}&display=5&sort=comment`,
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
            log('   ⚠️ GEMINI_API_KEY not configured — skipping AI venue resolution');
            return resolve({ success: false });
        }
        
        const prompt = `당신은 블로그 글에서 행사/팝업스토어가 열리는 실제 장소명과 도로명 주소를 추출하는 데이터 전문가입니다.
키워드: '${keyword}'

다음은 이 키워드에 대한 최근 블로그 리뷰 내용들입니다.
글을 분석하여 이 팝업스토어/행사가 개최된 **실제 장소(건물명, 백화점 지점 등)**와 **도로명 주소**를 찾아주세요.

## 추출 기준:
1. 도로명 주소(예: 서울특별시 영등포구 여의대로 108)가 명시되어 있거나, 개최 장소(예: 더현대 서울 5층)를 통해 주소를 명확히 유추할 수 있다면 해당 주소를 출력하세요.
2. 만약 개최 장소만 나오고 주소가 직접 안 나온다면, 잘 알려진 장소(예: 더현대 서울, AK플라자 홍대, 무신사 스토어 성수 등)일 경우 해당 장소의 표준 주소를 적어주세요.
3. 개최 장소나 주소를 전혀 알 수 없다면 null을 반환하세요.

출력 형식은 반드시 아래 JSON 형식으로만 답변하세요 (다른 설명이나 마크다운 백틱 없이 JSON 블록만 출력):
{
  "venue": "개최 장소명 (예: 더현대 서울 에픽 서울)",
  "address": "도로명 주소 (예: 서울특별시 영등포구 여의대로 108)",
  "success": true 또는 false
}

블로그 요약문:
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
        
        const prompt = `당신은 사용자가 입력한 트렌드 복합 키워드에서 네이버 지도(Naver Maps Local Search)에 검색하기 가장 좋은 '실제 상호명 + 지역명' 검색어를 정제해내는 데이터 전문가입니다.

## 작업 가이드:
1. 키워드에서 실질적인 상점/행사장/전시장 이름(상호명)을 추출하세요.
2. 상호명 앞뒤에 붙은 불필요한 수식어 및 검색 키워드(예: "한옥 와인", "퓨전 일식", "동화 감성", "클래스", "체험 코스", "분위기 좋은", "맛집", "카페 추천", "추천")는 제거하세요.
3. 키워드에 포함된 구체적인 지역명(예: "익선", "제기동", "서순라길", "연남동", "용산", "성수", "홍대")이 있다면 상호명 뒤에 붙여 최적화된 검색어를 만드세요. 네이버 지도 API는 "[상호명] [지역명]" 순서로 검색할 때 가장 높은 정확도로 매칭됩니다.
4. 예시:
   - "익선반주 한옥 다이닝" -> "익선반주 익선동" 또는 "익선반주"
   - "제기동 라이아 한옥 와인" -> "라이아 제기동"
   - "서순라길 이다 한식" -> "이다 서순라길"
   - "용산 도토리 동화 감성" -> "도토리 용산"
   - "연남동 연트럴다방" -> "연트럴다방 연남동"

출력 형식은 반드시 아래 JSON 형식으로만 답변하세요 (다른 설명이나 마크다운 백틱 없이 JSON 블록만 출력):
{
  "name": "상호명 (예: 이다)",
  "location": "지역명 (예: 서순라길)",
  "search_query": "네이버 지도 검색어 (예: 이다 서순라길)"
}
`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt + `\n\n입력 키워드: "${keyword}"` }] }],
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
    log('═══════════════════════════════════════════');
    log('  Kuromoon Map-First & Custom Collector');
    log('═══════════════════════════════════════════');

    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
        log('❌ ERROR: NAVER_CLIENT_ID or NAVER_CLIENT_SECRET is not configured in .env');
        process.exit(1);
    }

    // 2. Load Trend Keywords
    let trendsData = { categories: {} };
    if (fs.existsSync(TRENDS_FILE)) {
        try {
            trendsData = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf8'));
        } catch (e) {
            log(`⚠ Warning: Failed to parse trending_keywords.json: ${e.message}`);
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
        log(`⚠ No keywords met the threshold score >= ${SCORE_THRESHOLD}. Falling back to top 5 keywords overall.`);
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
                            label: '팝업스토어/전시',
                            trend_score: 100 // High priority
                        });
                    } else if (item && typeof item === 'object' && item.keyword) {
                        const catLabels = {
                            popup: '팝업스토어/전시',
                            beauty: 'K-뷰티/피부관리',
                            dining: '니치 다이닝',
                            cafe: '콘셉트 카페'
                        };
                        customKeywords.push({
                            keyword: item.keyword.trim(),
                            category: item.category || 'popup',
                            label: catLabels[item.category] || '팝업스토어/전시',
                            trend_score: 100 // High priority
                        });
                    }
                });
                log(`📂 Loaded ${customKeywords.length} custom keyword(s) from custom_keywords.json`);
            }
        } catch (e) {
            log(`⚠ Failed to parse custom_keywords.json: ${e.message}`);
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

    log(`🚀 Total ${targetKeywords.length} keywords scheduled for map-first extraction.`);

    // Load existing databases
    let existingPlaces = [];
    if (fs.existsSync(PLACES_FILE)) {
        try { existingPlaces = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')); } catch (e) {}
    }
    let reviewPlaces = [];
    if (fs.existsSync(REVIEW_FILE)) {
        try { reviewPlaces = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')); } catch (e) {}
    }

    function findExistingPlace(name, address) {
        const cleanN = name.replace(/\s+/g, '').toLowerCase();
        const cleanAddr = address ? address.replace(/\s+/g, '').toLowerCase() : '';
        
        let found = existingPlaces.find(p => p.name_ko.replace(/\s+/g, '').toLowerCase() === cleanN);
        if (!found) {
            found = reviewPlaces.find(p => p.name_ko.replace(/\s+/g, '').toLowerCase() === cleanN);
        }
        if (!found && cleanAddr) {
            found = existingPlaces.find(p => p.category !== 'popup' && p.category !== 'exhibition' && p.address_ko && p.address_ko.replace(/\s+/g, '').toLowerCase() === cleanAddr);
            if (!found) {
                found = reviewPlaces.find(p => p.category !== 'popup' && p.category !== 'exhibition' && p.address_ko && p.address_ko.replace(/\s+/g, '').toLowerCase() === cleanAddr);
            }
        }
        return found;
    }

    const rawInputs = [];

    // 3. Loop through keywords and perform Map-First Search
    for (const kwObj of targetKeywords) {
        const kw = kwObj.keyword;
        const catKey = kwObj.category;
        const catLabel = kwObj.label;

        log(`\n🔎 [Keyword] Processing: "${kw}" (Category: ${catLabel}, Score: ${kwObj.trend_score})`);

        try {
            // Step A: Search Naver Maps (Local Search) for actual registered businesses
            log(`   🗺️ Querying Naver Local Map for registered businesses...`);
            const localResults = await searchNaverLocal(kw);
            let places = localResults.items || [];

            if (places.length === 0) {
                log(`   ℹ No map results with original query. Cleaning up keyword using AI...`);
                const cleanQuery = await getCleanMapSearchQuery(kw);
                if (cleanQuery && cleanQuery !== kw) {
                    log(`   🎯 AI cleaned query: "${kw}" -> "${cleanQuery}"`);
                    const fallbackLocalResults = await searchNaverLocal(cleanQuery);
                    places = fallbackLocalResults.items || [];
                }
            }

            if (places.length === 0) {
                log(`   ℹ Still no map results. Hitting Naver Blog directly to resolve venue...`);
                const blogSearch = await searchNaverBlog(kw, 4, 'sim');
                const blogItems = blogSearch.items || [];
                
                if (blogItems.length > 0) {
                    const blogUrls = blogItems.map(item => item.link);
                    const processedBlogsPath = path.join(DATA_DIR, 'processed_blogs.json');
                    let processedBlogs = [];
                    if (fs.existsSync(processedBlogsPath)) {
                        try { processedBlogs = JSON.parse(fs.readFileSync(processedBlogsPath, 'utf8')); } catch (e) {}
                    }
                    
                    const allProcessed = blogUrls.every(url => processedBlogs.includes(url));
                    if (allProcessed) {
                        log(`   ℹ Skipping AI venue resolution for "${kw}" — all blog URLs are already processed (cached).`);
                        continue;
                    }

                    const snippets = blogItems.map(item => cleanHtml(item.description));
                    log(`   🧠 Calling Gemini to extract venue & address...`);
                    const aiResult = await extractVenueAndAddressWithAI(kw, snippets);
                    
                    // Save URLs to cache
                    blogUrls.forEach(url => {
                        if (!processedBlogs.includes(url)) {
                            processedBlogs.push(url);
                        }
                    });
                    try {
                        fs.writeFileSync(processedBlogsPath, JSON.stringify(processedBlogs, null, 2), 'utf8');
                    } catch (e) {
                        log(`   ⚠️ Failed to save processed_blogs.json: ${e.message}`);
                    }

                    if (aiResult && aiResult.success && aiResult.address) {
                        log(`   🎉 AI Resolved Venue: "${aiResult.venue}", Address: "${aiResult.address}"`);
                        places = [{
                            title: kw,
                            roadAddress: aiResult.address,
                            address: aiResult.address
                        }];
                    } else {
                        log(`   ⚠️ AI could not resolve address from blogs.`);
                    }
                } else {
                    log(`   ⚠️ No blogs found for keyword.`);
                }
            }

            if (places.length > 0) {
                const maxPlacesToProcess = Math.min(places.length, 2);
                log(`   ✅ Discovered ${places.length} matching places on Naver Maps. (Processing top ${maxPlacesToProcess})`);

                for (let idx = 0; idx < maxPlacesToProcess; idx++) {
                    const place = places[idx];
                    const placeName = cleanHtml(place.title);
                    const roadAddress = place.roadAddress || place.address || '';
                    
                    if (!placeName) continue;

                    log(`      📍 Place ${idx + 1}: "${placeName}" (${roadAddress})`);

                    // Step B: Search Naver Blogs for this specific place
                    const preciseQuery = getPreciseQuery(placeName, roadAddress, catKey);
                    log(`         🔍 Searching reviews for "${placeName}" using precise query: "${preciseQuery}"...`);
                    
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
                    const isCustom = customKeywords.some(ckw => ckw.keyword.toLowerCase() === kw.toLowerCase());
                    if (!isCustom && weeklyCount === 0 && biweeklyCount === 0 && reviewCount === 0) {
                        log(`         ℹ Skipping "${placeName}" because it has 0 reviews.`);
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
                        log(`         ℹ No blog reviews found for this specific place.`);
                        continue;
                    }

                    // Format reviews for Gemini parser
                    const reviewTexts = blogItems.map((item, bIdx) => {
                        const cleanTitle = cleanHtml(item.title);
                        const cleanDesc = cleanHtml(item.description);
                        return `[리뷰 ${bIdx + 1}]\n제목: ${cleanTitle}\n내용: ${cleanDesc}`;
                    }).join('\n\n');

                    // Inject Naver Map names & addresses directly so Gemini is guaranteed to output correct data
                    const sourceText = `검색 키워드: ${kw}
실제 지도 상호명: ${placeName}
실제 지도 도로명 주소: ${roadAddress}
카테고리: ${catLabel || catKey}

${reviewTexts}`;

                    // Generate ID
                    const id = placeName.toLowerCase()
                        .replace(/[^\w\s가-힣-]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-|-$/g, '')
                        .substring(0, 60);

                    // Check duplicate / existing
                    const existingPlace = findExistingPlace(placeName, roadAddress);
                    if (existingPlace) {
                        log(`         ♻️  Already in database: "${existingPlace.name_ko}" — marked to skip refine.`);
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
                log(`   ℹ No map results. Skipping direct blog search to prevent phantom places.`);
            }
        } catch (err) {
            log(`   ❌ Failed to process keyword "${kw}": ${err.message}`);
        }

        await sleep(500); // Rate limit between keywords
    }

    if (rawInputs.length === 0) {
        log('\n⚠️ Warning: No raw inputs collected. Preserving existing raw_inputs.json if any.');
        return;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(rawInputs, null, 2), 'utf8');
    log(`\n✅ Completed! Saved ${rawInputs.length} new raw inputs to raw_inputs.json`);
    log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
