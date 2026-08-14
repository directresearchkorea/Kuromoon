/**
 * Kuromoon Pipeline — Naver DataLab Trend Detection
 * 
 * Detects trending keywords among 10-20 year olds in Korea
 * using the Naver DataLab Shopping Insight API.
 * 
 * Usage: node pipeline/trend-detect.js
 * Env:   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * Output: data/trending_keywords.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^#\s][^=]+)=(.*)$/);
        if (match) {
            process.env[match[1].trim()] = match[2].trim();
        }
    });
}

const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'trending_keywords.json');
const HISTORY_FILE = path.join(DATA_DIR, 'trend_history.json');
const LOG_FILE = path.join(DATA_DIR, 'pipeline_log.json');

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

/**
 * Call Naver DataLab Shopping Insight API
 */
function callNaverDataLab(pathName, requestBody, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(requestBody);

        const options = {
            hostname: 'openapi.naver.com',
            path: pathName,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret,
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Naver API returned ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Call Naver Search Autocomplete API to fetch suggestion phrases
 */
function fetchNaverAutocomplete(query) {
    return new Promise((resolve) => {
        const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&con=1`;
        https.get(url, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const items = parsed.items?.[0] || [];
                    const keywords = items.map(item => item[0]);
                    resolve(keywords);
                } catch (e) {
                    resolve([]);
                }
            });
        }).on('error', () => {
            resolve([]);
        });
    });
}

/**
 * Call Gemini API with Google Search Grounding to discover trending keywords
 */
function makeGeminiRequest(prompt, apiKey) {
    return new Promise((resolve, reject) => {
        const GEMINI_API_URL = 'generativelanguage.googleapis.com';
        const GEMINI_MODEL = 'gemini-2.5-flash';
        
        const requestBody = JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            tools: [{
                googleSearch: {} // Enable Google Search Grounding
            }],
            generationConfig: {
                temperature: 0.2
            }
        });

        const options = {
            hostname: GEMINI_API_URL,
            path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`API returned status ${res.statusCode}: ${data.substring(0, 300)}`));
                    return;
                }
                let text = '';
                try {
                    const response = JSON.parse(data);
                    const candidate = response.candidates?.[0];
                    text = candidate?.content?.parts?.[0]?.text;
                    const finishReason = candidate?.finishReason;
                    
                    if (!text) {
                        reject(new Error(`Empty response from Gemini. Finish Reason: ${finishReason}`));
                        return;
                    }
                    
                    try {
                        // Attempt standard JSON parsing
                        const match = text.match(/```json\s*([\s\S]*?)\s*```/);
                        let candidateJson = match ? match[1] : text;
                        
                        const start = candidateJson.indexOf('{');
                        const end = candidateJson.lastIndexOf('}');
                        if (start !== -1 && end !== -1 && end > start) {
                            candidateJson = candidateJson.substring(start, end + 1);
                        }
                        
                        const cleaned = candidateJson.replace(/\[\d+\]/g, '').trim();
                        resolve(JSON.parse(cleaned));
                    } catch (jsonErr) {
                        log(`⚠️ JSON parse failed (Finish Reason: ${finishReason}). Attempting plain-text parser fallback...`);
                        
                        // Plain-text parser fallback
                        const lines = text.split('\n');
                        const parsed = { popup: [], activity: [], beauty: [], dining: [], cafe: [] };
                        let currentCat = null;
                        
                        for (let line of lines) {
                            line = line.trim();
                            if (line.startsWith('##') || line.startsWith('#')) {
                                const catName = line.replace(/#/g, '').trim().toLowerCase();
                                if (parsed[catName] !== undefined) {
                                    currentCat = catName;
                                } else if (catName.includes('popup') || catName.includes('팝업')) currentCat = 'popup';
                                else if (catName.includes('activity') || catName.includes('체험')) currentCat = 'activity';
                                else if (catName.includes('beauty') || catName.includes('뷰티')) currentCat = 'beauty';
                                else if (catName.includes('dining') || catName.includes('다이닝')) currentCat = 'dining';
                                else if (catName.includes('cafe') || catName.includes('카페')) currentCat = 'cafe';
                            } else if (currentCat && line) {
                                const match = line.match(/^(?:\d+[\.\)]|\-|\*)\s*(.*)$/);
                                if (match) {
                                    const kw = match[1].replace(/\[\d+\]/g, '').trim();
                                    if (kw && parsed[currentCat].length < 10) {
                                        parsed[currentCat].push(kw);
                                    }
                                } else if (!line.startsWith('##') && line.length > 1 && line.length < 30) {
                                    // Raw list item without bullet
                                    const kw = line.replace(/\[\d+\]/g, '').trim();
                                    if (parsed[currentCat].length < 10) {
                                        parsed[currentCat].push(kw);
                                    }
                                }
                            }
                        }
                        
                        // Check if we successfully parsed at least some categories
                        const hasKeys = Object.values(parsed).some(arr => arr.length > 0);
                        if (hasKeys) {
                            resolve(parsed);
                        } else {
                            throw jsonErr; // Re-throw original JSON error if fallback failed completely
                        }
                    }
                } catch (err) {
                    console.error("❌ Raw Gemini output that failed to parse:");
                    console.error(text);
                    reject(new Error(`Failed to parse Gemini JSON: ${err.message}`));
                }
            });
        });

        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}

/**
 * Generate sample trending data for demo mode
 */
function generateSampleTrending() {
    const today = new Date().toISOString().split('T')[0];
    return {
        generated_at: today,
        mode: 'demo',
        note: 'Sample data — set NAVER_CLIENT_ID and NAVER_CLIENT_SECRET for real API data',
        categories: {
            popup: {
                label: '팝업스토어/전시',
                trending_keywords: [
                    { keyword: '성수 팝업', trend_score: 95 },
                    { keyword: '젠틀몬스터 팝업', trend_score: 88 },
                    { keyword: '무신사 팝업스토어', trend_score: 82 },
                    { keyword: '서울 전시회', trend_score: 75 },
                    { keyword: '홍대 팝업', trend_score: 70 }
                ]
            },
            beauty: {
                label: 'K-뷰티/피부관리',
                trending_keywords: [
                    { keyword: '피부과 추천', trend_score: 90 },
                    { keyword: '강남 피부과', trend_score: 85 },
                    { keyword: '외국인 미용실', trend_score: 78 },
                    { keyword: '한국 피부관리', trend_score: 72 },
                    { keyword: '성수 네일샵', trend_score: 65 }
                ]
            },
            dining: {
                label: '니치 다이닝',
                trending_keywords: [
                    { keyword: '비건 식당 서울', trend_score: 92 },
                    { keyword: '할랄 레스토랑', trend_score: 80 },
                    { keyword: '이태원 맛집', trend_score: 77 },
                    { keyword: '혼밥 맛집', trend_score: 73 },
                    { keyword: '글루텐프리 카페', trend_score: 68 }
                ]
            },
            cafe: {
                label: '콘셉트 카페',
                trending_keywords: [
                    { keyword: '성수 카페', trend_score: 93 },
                    { keyword: '콘센트 카페', trend_score: 84 },
                    { keyword: '루프탑 카페 서울', trend_score: 79 },
                    { keyword: '반려동물 카페', trend_score: 74 },
                    { keyword: '한남동 디저트', trend_score: 69 }
                ]
            }
        }
    };
}

/**
 * Main execution
 */
async function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon Trend Detection Engine');
    log('  (Naver DataLab Shopping Insight)');
    log('═══════════════════════════════════════════');

    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    const today = new Date();
    const endDate = today.toISOString().split('T')[0];
    const startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Predefined generic fallback keywords (used if Gemini fails, making up 10 keywords total)
    const predefinedFallbacks = {
        popup: ['성수 팝업스토어', '더현대 서울 팝업', '무신사 성수 팝업', '서울 미디어아트 전시', '홍대 이색 팝업', '캐릭터 콜라보 팝업', '잠실 롯데월드몰 팝업', 'DDP 특별 전시', '성수 팝업 공간', '여의도 더현대 전시'],
        activity: ['성수 향수공방 체험', '홍대 이색 반지공방', '가죽공방 원데이클래스', '도자기 원데이클래스', '몰입형 드로잉카페', '성수동 아트공방', '프리미엄 조향클래스', '터프팅 공방 체험', '베이킹 원데이클래스', '홍대 테마 방탈출'],
        beauty: ['퍼스널컬러 진단 전문', '성수 프라이빗 헤드스파', '홍대 퍼스널컬러 컨설팅', '프리미엄 웰니스 스파', '강남 프라이빗 헤어스파', '두피 디톡스 헤드스파', '한방 웰니스 스파', '청담동 고급 뷰티스파', '성수동 향기 테라피', '호텔 럭셔리 스파'],
        dining: ['미디어아트 다이닝', '한옥 다도체험 코스', '스토리텔링 오마카세', '이색 테마 파인다이닝', '블라인드 레스토랑', '프라이빗 티 하우스', '성수동 미디어아트 식당', '몰입형 퓨전 다이닝', '컨셉 스토어 레스토랑', '전통 차회 코스'],
        cafe: ['바이닐 LP 청음 카페', '디저트 오마카세 코스', '성수동 컨셉 스토어 카페', '이머시브 갤러리 카페', '해리포터 테마 카페', '레트로 감성 다방', '프라이빗 티 오마카세', '한옥 개조 디저트카페', '플랜테리어 식물원 카페', '빈티지 감성 북카페']
    };

    // Category definitions mapping internal names, labels, and Naver Shopping categories
    const categories = [
        { name: 'popup', label: '팝업/전시', category: '50000000' },
        { name: 'activity', label: '이색 체험', category: '50000004' },
        { name: 'beauty', label: '뷰티/웰니스', category: '50000002' },
        { name: 'dining', label: '컨셉 다이닝', category: '50000006' },
        { name: 'cafe', label: '아트/테마 카페', category: '50000008' }
    ];

    // 1. Fetch Dynamic Keywords via Gemini (Google Search Grounding)
    let dynamicKeywords = null;
    if (geminiApiKey) {
        log('🤖 Fetching live trends from Gemini (with Google Search Grounding)...');
        const prompt = `당신은 한국의 로컬 검색 및 SNS 소셜 미디어 트렌드 분석 전문가입니다.
현재 한국(특히 서울)의 10대~30대 젊은층 사이에서 가장 반응이 뜨겁고 **새롭고 독특한 경험(New Experience)을 제공하는 최신 검색 트렌드 키워드**를 카테고리별로 10개씩 찾아주세요.

## 중요 주의사항 (크리티컬):
1. **SNS 숏폼 및 소셜 미디어 트렌드 포착 (매우 중요)**:
   - 네이버 등 메이저 포털사이트에 아직 대대적으로 검색량이 오르기 전이더라도, **인스타그램 릴스, 틱톡, 스레드(Threads) 등 젊은 층 중심의 숏폼 SNS 채널에서 최근 1~2주 내 해시태그나 조회수가 급증하며 강하게 바이럴을 타고 있는 극초기 신상 핫플레이스, 가오픈 매장, 브랜드 쇼룸, 팝업스토어, 이색 체험 공방의 상호명이나 구체적인 행사명**을 적극적으로 발굴해야 합니다.
2. **경험 및 구체성 중심**:
   - 단순히 '성수 카페'나 '홍대 공방' 같은 뻔하고 넓은 지역 키워드는 제외하십시오.
   - **일반 상설 매장 및 체인점 배제 (필수)**: '아더에러 플래그십', '나이키 강남', '하이디라오 홍대점'과 같은 상시 운영되는 유명 체인점, 일반 명품 매장, 정규 지점은 제외하세요.
   - 브랜드 공간의 경우 **반드시 행사명에 '팝업'이나 '전시'가 포함된 한시적 기획 공간**만 포함하세요 (예: '디올 성수 팝업').
   - 단, 카테고리가 cafe나 dining인 경우 '미디어아트 다이닝', '디저트 오마카세', '테마 카페' 등 **독보적인 체험형 요소를 갖춘 핫플레이스라면 상설 매장이라도 예외로 허용**합니다.
   - 예시: 
     - popup: '디올 성수 팝업스토어', '특정 브랜드 콜라보 전시명', '동대문 디자인플라자 이색 전시'
     - activity: '성수동 향수공방 (특정 인기 상호)', '드로잉 카페', '반지 원데이 클래스'
     - beauty: '퍼스널컬러 진단 전문', '성수동 헤드스파', '고급 웰니스 스파' (단순 치료 목적의 일반 피부과나 동네 미용실은 제외)
     - dining: '미디어아트 다이닝', '한옥 다도체험 코스', '비주얼 오마카세' (일반 밥집, 고깃집, 체인점 식당 제외)
     - cafe: 'LP 청음 카페', '디저트 오마카세', '해리포터 테마 카페' (일반 프랜차이즈나 평범한 동네 카페 제외)
3. **검색 최적화 키워드 형식 (길이 제한 및 고유 상호명 지향)**:
   - 검색어는 네이버 검색어 트렌드 분석 및 지도 검색에 최적화되도록 **2~4단어 내외(최대 15자 이내)의 짧고 명확한 검색어**로 작성하세요.
   - 문장형이나 장황한 수식어 대신, 소비자들이 실제 포털 검색창에 입력하는 핵심 고유명사 위주(예: '비라이트 공방', '홍대 반지공방', '카니랩', '디올 성수 팝업')로만 리스트를 채우십시오.
4. **한글 표기법 준수**:
   - 검색어 키워드는 반드시 한글(한국어)로 작성하세요. 영어 브랜드나 상호명의 경우 반드시 실사용자들이 네이버 등에서 검색하는 한글 표기법을 사용해야 합니다.
5. **각주 표시 절대 금지**:
   - 출력되는 JSON 값 내부나 외부에 구글 검색 출처 각주 표시(예: [1], [2])를 절대 포함하지 마세요. 각주 표시 대괄호가 들어가면 JSON 파싱이 깨집니다.

## 수집 채널 및 분석 기준:
1. 인스타그램 릴스/틱톡/스레드 등 숏폼 SNS 트렌드 해시태그 및 바이럴 핫플레이스 쿼리
2. 네이버 블로그/카페 및 최근 급상승 로컬 장소, 신상 팝업, 카페 테마
3. 네이버 쇼핑 베스트 인기 검색어

## 대상 카테고리 (JSON의 Key 명칭은 반드시 아래의 영어 단어 5가지로 한정합니다):
- popup: 팝업/전시
- activity: 이색 체험
- beauty: 뷰티/웰니스
- dining: 컨셉 다이닝
- cafe: 아트/테마 카페

## 출력 규칙:
- 각 카테고리별로 10개의 가장 트렌디하고 화제가 되는 '검색어 키워드'를 추천해야 합니다.
- 검색어는 사용자가 네이버나 구글에 실제로 입력할 법한 명사 위주의 검색 쿼리 형태여야 합니다.
- **반드시 아래 명시된 JSON 형식으로만** 응답하세요. 다른 설명이나 마크다운 기호는 절대 출력하지 마세요.

## JSON Response Schema:
{
  "popup": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5", "키워드6", "키워드7", "키워드8", "키워드9", "키워드10"],
  "activity": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5", "키워드6", "키워드7", "키워드8", "키워드9", "키워드10"],
  "beauty": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5", "키워드6", "키워드7", "키워드8", "키워드9", "키워드10"],
  "dining": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5", "키워드6", "키워드7", "키워드8", "키워드9", "키워드10"],
  "cafe": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5", "키워드6", "키워드7", "키워드8", "키워드9", "키워드10"]
}
`;
    try {
            dynamicKeywords = await makeGeminiRequest(prompt, geminiApiKey);
            log('✅ Dynamic trends fetched successfully.');
        } catch (e) {
            log(`⚠️ Failed to fetch dynamic trends: ${e.message}. Using predefined fallbacks.`);
        }
    } else {
        log('ℹ️ GEMINI_API_KEY not configured. Using predefined fallbacks.');
    }

    // If no geminiApiKey AND no Naver keys, fallback to static demo
    if (!geminiApiKey && (!clientId || !clientSecret)) {
        log('❌ No Gemini API key and no Naver DataLab API keys configured.');
        log('💡 Generating sample trending data for demo...');
        const sampleData = generateSampleTrending();
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sampleData, null, 2), 'utf8');
        log(`✅ Demo trending data saved to trending_keywords.json`);
        log('═══════════════════════════════════════════\n');
        return;
    }

    const result = {
        generated_at: endDate,
        mode: dynamicKeywords ? 'live-dynamic' : 'live-fallback',
        period: { start: startDate, end: endDate },
        categories: {}
    };

    const hasNaverApi = clientId && clientSecret;
    if (!hasNaverApi) {
        log('⚠ NAVER_CLIENT_ID or NAVER_CLIENT_SECRET not set. Using heuristic ranking for discovered trends.');
    }

    // 2. Process each category, merge keywords, and query Naver DataLab or rank heuristically
    for (const cat of categories) {
        log(`\n🔍 Processing Category: ${cat.label}`);
        
        const autocompleteSeeds = {
            popup: ['성수 팝업', '더현대 팝업', '서울 전시'],
            activity: ['원데이클래스', '이색 체험', '공방'],
            beauty: ['퍼스널컬러', '성수 헤드스파', '웰니스'],
            dining: ['다이닝', '오마카세', '이색맛집'],
            cafe: ['LP 카페', '디저트 오마카세', '가오픈 카페']
        };

        let kwList = [];
        const seen = new Set();

        // Fetch autocomplete suggestions for seeds
        const autoKeywords = [];
        const seeds = autocompleteSeeds[cat.name] || [];
        for (const seed of seeds) {
            try {
                const suggestions = await fetchNaverAutocomplete(seed);
                suggestions.forEach(kw => {
                    const cleaned = kw.trim();
                    if (cleaned && cleaned.length >= 3 && cleaned.length <= 20 && !cleaned.includes('지역') && !cleaned.includes('추천')) {
                        autoKeywords.push(cleaned);
                    }
                });
            } catch (e) {
                // Ignore autocomplete error
            }
        }

        // 1. Merge Gemini dynamic keywords
        if (dynamicKeywords && dynamicKeywords[cat.name]) {
            dynamicKeywords[cat.name].forEach(kw => {
                const cleaned = kw.trim();
                if (cleaned && !seen.has(cleaned)) {
                    seen.add(cleaned);
                    kwList.push(cleaned);
                }
            });
        }

        // 2. Merge Autocomplete keywords (up to 5 unique suggestions)
        let addedAutoCount = 0;
        for (const kw of autoKeywords) {
            if (!seen.has(kw)) {
                seen.add(kw);
                kwList.push(kw);
                addedAutoCount++;
                if (addedAutoCount >= 5) break;
            }
        }

        // 3. Fallbacks padding if we have less than 10 keywords
        if (kwList.length < 10) {
            const fallbacks = predefinedFallbacks[cat.name];
            for (const fallback of fallbacks) {
                if (!seen.has(fallback)) {
                    seen.add(fallback);
                    kwList.push(fallback);
                    if (kwList.length >= 10) break;
                }
            }
        }

        // 4. Cap validation pool to maximum 15 keywords
        kwList = kwList.slice(0, 15);

        log(`   → Keywords to validate: ${JSON.stringify(kwList)}`);

        if (hasNaverApi) {
            try {
                const baseline = kwList[0];
                const restKeywords = kwList.slice(1);
                const chunkSize = 4;
                const chunks = [];
                for (let i = 0; i < restKeywords.length; i += chunkSize) {
                    chunks.push(restKeywords.slice(i, i + chunkSize));
                }

                const allResults = [];
                let firstBaselineRatio = 0;

                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const groupKeywords = [baseline, ...chunk];
                    const requestBody = {
                        startDate,
                        endDate,
                        timeUnit: 'week',
                        keywordGroups: groupKeywords.map(kw => ({
                            groupName: kw,
                            keywords: [kw]
                        })),
                        ages: ['2', '3', '4'] // 13~29세 필터
                    };

                    log(`   → Querying Naver DataLab chunk ${i + 1}/${chunks.length} with keywords: ${groupKeywords.join(', ')}`);
                    const response = await callNaverDataLab('/v1/datalab/search', requestBody, clientId, clientSecret);
                    const trendData = response.results || [];

                    const baselineItem = trendData.find(item => item.title === baseline);
                    const baselineLatestData = baselineItem && baselineItem.data && baselineItem.data.length > 0 ? baselineItem.data[baselineItem.data.length - 1] : null;
                    const baselineRatio = baselineLatestData ? baselineLatestData.ratio : 0;

                    if (i === 0) {
                        firstBaselineRatio = baselineRatio;
                    }

                    trendData.forEach(item => {
                        const latestData = item.data && item.data.length > 0 ? item.data[item.data.length - 1] : null;
                        const ratio = latestData ? latestData.ratio : 0;
                        const dataPoints = item.data?.length || 0;

                        let normalizedRatio = ratio;
                        if (i > 0 && baselineRatio > 0 && firstBaselineRatio > 0) {
                            normalizedRatio = ratio * (firstBaselineRatio / baselineRatio);
                        }

                        if (item.title === baseline) {
                            if (i === 0) {
                                allResults.push({
                                    keyword: item.title,
                                    trend_score: Math.round(normalizedRatio),
                                    data_points: dataPoints
                                });
                            }
                        } else {
                            allResults.push({
                                keyword: item.title,
                                trend_score: Math.round(normalizedRatio),
                                data_points: dataPoints
                            });
                        }
                    });

                    if (i < chunks.length - 1) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }

                const maxScore = Math.max(...allResults.map(r => r.trend_score));
                if (maxScore > 0) {
                    allResults.forEach(r => {
                        r.trend_score = Math.round((r.trend_score / maxScore) * 100);
                    });
                }

                // Apply a Dynamic Discovery Floor (Min 30 points) for Gemini discovered keywords
                // to prevent newly discovered trends with 0 DataLab volume from getting dropped
                const dynamicList = (dynamicKeywords && dynamicKeywords[cat.name]) ? dynamicKeywords[cat.name].map(k => k.trim().toLowerCase()) : [];
                allResults.forEach(r => {
                    const isDynamic = dynamicList.includes(r.keyword.trim().toLowerCase());
                    if (isDynamic) {
                        r.trend_score = Math.max(r.trend_score, 30);
                    }
                });

                allResults.sort((a, b) => b.trend_score - a.trend_score);

                // Take top 10 results
                const top10Results = allResults.slice(0, 10);

                result.categories[cat.name] = {
                    label: cat.label,
                    trending_keywords: top10Results
                };

                log(`   ✅ Validated and ranked (normalized): ${top10Results.map(k => `${k.keyword}(${k.trend_score}점)`).join(', ')}`);
            } catch (err) {
                log(`   ❌ DataLab Error: ${err.message}`);
                result.categories[cat.name] = {
                    label: cat.label,
                    trending_keywords: kwList.slice(0, 10).map((kw, idx) => ({ keyword: kw, trend_score: Math.round(100 - (idx * 10)) })),
                    error: err.message
                };
            }
        } else {
            // Heuristic ranking based on combined list index
            const top10List = kwList.slice(0, 10);
            const keywords = top10List.map((kw, idx) => ({
                keyword: kw,
                trend_score: Math.round(100 - (idx * (100 / top10List.length))),
                data_points: 4 // dummy
            }));
            
            result.categories[cat.name] = {
                label: cat.label,
                trending_keywords: keywords
            };
            log(`   ✅ Heuristically ranked (no Naver API): ${keywords.map(k => `${k.keyword}(${k.trend_score}점)`).join(', ')}`);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
    log(`\n✅ Trending data saved to trending_keywords.json`);

    // ─── Append to trend_history.json ───
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) { history = []; }
    }
    history.push({
        timestamp: new Date().toISOString(),
        categories: result.categories
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    log(`📊 Trend snapshot appended to trend_history.json (${history.length} total)`);

    // ─── Append to pipeline_log.json ───
    let pipeLog = [];
    if (fs.existsSync(LOG_FILE)) {
        try { pipeLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) { pipeLog = []; }
    }
    const totalKeywords = Object.values(result.categories).reduce((sum, cat) => sum + (cat.trending_keywords?.length || 0), 0);
    pipeLog.push({
        timestamp: new Date().toISOString(),
        step: 'trend-detect',
        status: 'success',
        summary: `${Object.keys(result.categories).length}개 카테고리에서 트렌드 키워드 ${totalKeywords}개 감지 (${result.mode})`
    });
    fs.writeFileSync(LOG_FILE, JSON.stringify(pipeLog, null, 2), 'utf8');

    log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    log(`❌ Fatal error: ${err.message}`);
    try {
        let pipeLog = [];
        if (fs.existsSync(LOG_FILE)) {
            pipeLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
        pipeLog.push({
            timestamp: new Date().toISOString(),
            step: 'trend-detect',
            status: 'error',
            summary: `Fatal error: ${err.message}`
        });
        fs.writeFileSync(LOG_FILE, JSON.stringify(pipeLog, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to log fatal error to pipeline_log.json:', e.message);
    }
    process.exit(1);
});
