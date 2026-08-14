/**
 * Kuromoon Pipeline — Naver Blog Crawler & AI Operating Status Checker
 * 
 * 1. Reads refined_places.json
 * 2. Uses Naver Blog Search API (sort=date) to fetch real review counts and top 3 recent posts.
 * 3. Uses Gemini AI to determine if the place is currently operating based on the 3 recent posts.
 * 4. Saves results back to refined_places.json.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const PLACES_FILE = path.join(DATA_DIR, 'raw_inputs.json');

// Load .env
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
 * Call Naver Blog Search API
 */
function searchNaverBlog(query, display = 3, sort = 'date') {
    return new Promise((resolve, reject) => {
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
                    return reject(new Error(`Naver API error: ${res.statusCode} ${data}`));
                }
                resolve(JSON.parse(data));
            });
        });
        req.on('error', reject);
        req.end();
    });
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
        // Extract Si/Gu/Dong/Gu/City (e.g. "성수동", "마포구")
        const match = address.match(/([가-힣]+(구|동|읍|면|시))/);
        if (match) {
            region = match[1] + ' ';
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
 * Call Naver Local Search API to find precise business address
 */
function searchNaverLocal(query) {
    return new Promise((resolve, reject) => {
        if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
            return reject(new Error('Naver client keys not configured'));
        }
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/local.json?query=${encodeURIComponent(query)}&display=1`,
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
                    return reject(new Error(`Naver Local API returned ${res.statusCode}: ${data.substring(0, 200)}`));
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
 * Call Gemini AI for Operating Status Check
 */
function checkOperatingStatusWithAI(placeName, snippets) {
    return new Promise((resolve, reject) => {
        if (!snippets || snippets.length === 0) {
            return resolve('확인 불가 (리뷰 없음)');
        }

        const prompt = `당신은 로컬 상점의 영업 상태를 판별하는 분석 전문가입니다.
다음은 '${placeName}'에 대한 가장 최근 블로그 리뷰 요약문 3개입니다.
이 글들을 바탕으로 현재 이곳의 영업/운영 상태를 정확히 판단해주세요.

## 상태 판별 기준 (필독):
1. **과거형 문장 해석 (중요)**:
   - 블로그 후기는 특성상 항상 과거형("다녀왔다", "맛있게 먹었다", "전시를 보았다")으로 쓰입니다. 이는 정상적으로 영업 중인 곳에 다녀왔다는 뜻이므로, 절대 이를 '영업 종료'나 '행사 종료'로 판단하지 마세요. 방문 후기가 존재한다는 것 자체가 현재 활발히 **"운영 중"**임을 뜻합니다.
2. **종료/폐업 판정 조건 (엄격)**:
   - 본문에 명시적으로 "폐업했다", "영업을 종료했다", "문 닫았다", "더 이상 안 한다", "망했다", "임시 휴업했다" 등의 직접적인 종료 언급이 있는 경우에만 "영업 종료" 또는 "행사 종료"로 판정하세요.
3. **기본값**:
   - 방문 후기나 메뉴 맛에 대한 글만 가득하고 폐업 단서가 없다면 기본적으로 **"운영 중"**으로 판정해야 합니다.
   - 글의 맥락이 너무 모호하거나 관련이 없는 글뿐이라 판단하기 어렵다면 **"확인 불가"**로 판정하세요.

출력 형식은 오직 다음 4가지 중 하나의 단어로만 답변하세요 (따옴표나 다른 설명 없이 한 단어만 출력):
"운영 중", "행사 종료", "영업 종료", "확인 불가"

리뷰 요약문:
${snippets.map((s, i) => `[리뷰 ${i + 1}]\n${s}`).join('\n\n')}
`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 100
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
                        resolve(text);
                    } else {
                        resolve('확인 불가');
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}

/**
 * Call Gemini AI to analyze if a date-defined event was extended
 */
function checkEventExtensionWithAI(placeName, originalEndDate, snippets) {
    return new Promise((resolve) => {
        if (!snippets || snippets.length === 0) {
            return resolve({ extended: false });
        }

        const prompt = `당신은 행사 및 팝업스토어 정보 검증 전문가입니다.
행사명: '${placeName}'
원래 종료일: ${originalEndDate}

다음은 이 행사의 최근 블로그 리뷰 내용입니다. 현재 날짜는 ${new Date(Date.now() + 9*60*60*1000).toISOString().slice(0, 10)}입니다.
원래 종료일이 지났음에도 불구하고, 최근 후기에서 이 행사가 **"기간 연장"**되어 현재도 운영 중이라는 언급이 있는지 분석해주세요.

## 분석 기준:
1. 최근 후기에서 "연장 결정", "기간 연장", "추가 운영", "~일까지 연장 운영한다" 등의 직접적인 연장 정보가 확실히 언급되어 있는 경우에만 연장으로 판단하세요.
2. 단순히 과거 방문 후기만 있고 연장에 대한 언급이 없다면 연장이 아닌 것으로 판단해야 합니다.

출력 형식은 반드시 아래 JSON 형식으로만 답변하세요 (다른 설명이나 마크다운 백틱 없이 JSON 블록만 출력):
{
  "extended": true 또는 false,
  "new_end_date": "YYYY-MM-DD" 또는 null (새로운 종료일이 언급된 경우 입력)
}

리뷰 요약문:
${snippets.map((s, i) => `[리뷰 ${i + 1}]\n${s}`).join('\n\n')}
`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 150
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
                        const result = JSON.parse(cleaned);
                        resolve(result);
                    } else {
                        resolve({ extended: false });
                    }
                } catch (e) {
                    resolve({ extended: false });
                }
            });
        });
        req.on('error', () => resolve({ extended: false }));
        req.write(requestBody);
        req.end();
    });
}

function normalizeStatus(statusText) {
    if (!statusText) return '확인 불가';
    const text = statusText.replace(/[^가-힣a-zA-Z]/g, '').trim(); // Remove spaces/symbols
    
    if (text.includes('임시휴업') || text.includes('휴업')) {
        return '임시 휴업';
    }
    if (text.includes('조기종료')) {
        return '조기 종료';
    }
    if (text.includes('운영중') || text.includes('영업중') || text.includes('운영') || text === '운') {
        return '운영 중';
    }
    if (text.includes('행사중') || text.includes('진행중') || text === '행') {
        return '행사 중';
    }
    if (text.includes('행사종료') || text.includes('종료')) {
        return '행사 종료';
    }
    if (text.includes('영업종료') || text.includes('폐업') || text.includes('문닫음')) {
        return '영업 종료';
    }
    return '확인 불가';
}

async function processPlace(place, nowKst) {
    log('\n🔍 Checking: ' + place.name_ko);
    const todayStr = nowKst.toISOString().slice(0, 10);
    const isTemporaryEvent = place.type === 'Event' || ['popup', 'festival', 'exhibition', 'fair'].includes(place.category);

    // 1. Temporary Events Date-based Status Transition (No API calls)
    if (isTemporaryEvent) {
        if (place.startDate && place.endDate) {
            log(`   📅 Date Auto-Transition for Event: ${place.startDate} ~ ${place.endDate}`);
            if (todayStr > place.endDate) {
                place.operating_status = '행사 종료';
            } else if (todayStr < place.startDate) {
                place.operating_status = '행사 예정';
            } else {
                place.operating_status = '행사 중';
            }
            log(`   - Operating Status: ${place.operating_status} (Calculated locally, skipped APIs)`);
            return;
        }
        // If event has no dates, fall through to status check
    }

    // 2. Permanent Places (Skip closed/already-checked places)
    if (place.operating_status === '영업 종료' || place.operating_status === '폐업' || place.operating_status === '행사 종료') {
        log(`   - Skipping status check: Place is already ended/closed (${place.operating_status})`);
        return;
    }

    const lastChecked = place.last_status_checked_at;
    if (lastChecked) {
        const diffTime = Math.abs(nowKst - new Date(lastChecked));
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays < 90) {
            log(`   - Skipping status check: Checked ${diffDays} days ago (< 90 days). Status: ${place.operating_status}`);
            return;
        }
    }

    // 3. Status Verification (API Fallback)
    let snippets = [];
    let weeklyCount = 0;
    let biweeklyCount = 0;
    let reviewCount = 0;

    try {
        const searchQuery = getPreciseQuery(place.name_ko, place.address_ko, place.category);
        log('   - Search Query: "' + searchQuery + '"');
        log('   - Fetching review counts & snippets (Verification)...');

        const searchResult = await searchNaverBlog(searchQuery, 30, 'date');
        reviewCount = searchResult.total || 0;
        place.review_count = reviewCount;
        log('   - Total Reviews Found: ' + reviewCount);

        const sevenDaysAgo = new Date(nowKst.getTime() - 7 * 24 * 60 * 60 * 1000);
        const fourteenDaysAgo = new Date(nowKst.getTime() - 14 * 24 * 60 * 60 * 1000);

        (searchResult.items || []).forEach(item => {
            const dateStr = item.postdate;
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

        place.weekly_review_count = weeklyCount;
        place.biweekly_review_count = biweeklyCount;
        log('   - Weekly Reviews: ' + weeklyCount + ', Biweekly Reviews: ' + biweeklyCount);

        const recentItems = (searchResult.items || []).slice(0, 3);
        snippets = recentItems.map(item => item.description.replace(/<[^>]*>?/gm, ''));

        log('   - AI Analyzing recent ' + snippets.length + ' posts...');
        const status = await checkOperatingStatusWithAI(place.name_ko, snippets);
        let operatingStatus = normalizeStatus(status);

        if (operatingStatus === '확인 불가' || operatingStatus === '확인 불가 (에러)') {
            if (weeklyCount >= 1 || biweeklyCount >= 2) {
                operatingStatus = '운영 중';
                log('   💡 Heuristic Override: \'확인 불가\' changed to \'운영 중\' due to recent review velocity');
            }
        }
        place.operating_status = operatingStatus;
        place.last_status_checked_at = todayStr;
        log('   - Operating Status: ' + place.operating_status);
    } catch (err) {
        log('   ❌ Error processing ' + place.name_ko + ': ' + err.message);
        place.review_count = 0;
        place.operating_status = '확인 불가 (에러)';
    }
}

async function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon Data Crawler & Status Checker');
    log('═══════════════════════════════════════════');

    if (!fs.existsSync(PLACES_FILE)) {
        log(`❌ ${PLACES_FILE} not found. Run refine.js first.`);
        process.exit(1);
    }

    let places = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
    
    // Also re-crawl existing review-needed places that are marked as '확인 불가' or '확인 불가 (에러)'
    const reviewFile = path.join(path.dirname(PLACES_FILE), 'review_needed.json');
    const discardedFile = path.join(path.dirname(PLACES_FILE), 'discarded_places.json');
    let reviewPlaces = [];
    let discardedPlaces = [];
    if (fs.existsSync(discardedFile)) {
        try { discardedPlaces = JSON.parse(fs.readFileSync(discardedFile, 'utf8')); } catch (e) {}
    }
    if (fs.existsSync(reviewFile)) {
        try {
            reviewPlaces = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
            
            const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
            const todayStr = nowKst.toISOString().slice(0, 10);
            
            const placesToKeep = [];
            const placesToRecrawl = [];
            
            reviewPlaces.forEach(p => {
                const isUnknown = p.operating_status === '확인 불가' || p.operating_status === '확인 불가 (에러)';
                if (isUnknown) {
                    // Check if 3 days have passed
                    const createdAt = p.created_at || todayStr;
                    const diffTime = Math.abs(nowKst - new Date(createdAt));
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    
                    if (diffDays >= 3) {
                        if (!p.recheck_count || p.recheck_count < 1) {
                            log(`   🔄 3 days passed since creation (${createdAt}) for '${p.name_ko}'. Scheduling 1-time recheck.`);
                            p.recheck_count = 1;
                            placesToRecrawl.push(p);
                        } else {
                            log(`   ❌ '${p.name_ko}' has already been rechecked once and remains '확인 불가'. Discarding.`);
                            p.discard_reason = 'Failed recheck after 3 days';
                            discardedPlaces.push(p);
                        }
                    } else {
                        log(`   ⏳ '${p.name_ko}' is '확인 불가' but created on ${createdAt} (< 3 days ago). Skipping recheck.`);
                        placesToKeep.push(p);
                    }
                } else {
                    placesToKeep.push(p);
                }
            });

            fs.writeFileSync(reviewFile, JSON.stringify(placesToKeep, null, 2), 'utf8');
            fs.writeFileSync(discardedFile, JSON.stringify(discardedPlaces, null, 2), 'utf8');

            if (placesToRecrawl.length > 0) {
                log(`   🔄 Appending ${placesToRecrawl.length} place(s) for re-crawling...`);
                placesToRecrawl.forEach(up => {
                    if (!places.some(p => p.id === up.id)) {
                        places.push(up);
                    }
                });
            }
        } catch (e) {
            log(`⚠️ Error reading/processing review_needed.json for re-crawl: ${e.message}`);
        }
    }
    
    
    let nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < places.length; i += BATCH_SIZE) {
        const batch = places.slice(i, i + BATCH_SIZE);
        log('\n⏳ Processing batch ' + (Math.floor(i / BATCH_SIZE) + 1) + ' of ' + Math.ceil(places.length / BATCH_SIZE) + ' (Size: ' + batch.length + ')...');
        
        await Promise.all(batch.map(place => processPlace(place, nowKst)));
        
        if (i + BATCH_SIZE < places.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }


    fs.writeFileSync(PLACES_FILE, JSON.stringify(places, null, 2), 'utf8');
    log('\n✅ Crawler complete. Updated raw_inputs.json');
    log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    log(`❌ Fatal Error: ${err.message}`);
    process.exit(1);
});
