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

function getShortKeyword(kw) {
    let short = kw.replace(/\[.*?\]|\(.*?\)|<.*?>/g, '').trim();
    short = short.split(':')[0].trim();
    short = short.split('-')[0].trim();
    const words = short.split(/\s+/);
    if (words.length > 3) {
        return words.slice(0, 3).join(' ');
    }
    return short;
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
 * Call Naver Blog Search API to fetch real-time blog data
 */
function searchNaverBlog(query, clientId, clientSecret, display = 40, sort = 'date') {
    return new Promise((resolve) => {
        if (!clientId || !clientSecret) return resolve([]);
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        };
        https.get(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.items || []);
                } catch (e) {
                    resolve([]);
                }
            });
        }).on('error', () => resolve([]));
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
            
            tools: [{ googleSearch: {} }],
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
                        
                        const cleaned = candidateJson.replace(/\[\d+\]/g, '').replace(/\[|\]/g, '').trim();
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
                                    const kw = match[1].replace(/\[\d+\]/g, '').replace(/\[|\]/g, '').trim();
                                    if (kw && parsed[currentCat].length < 10) {
                                        parsed[currentCat].push(kw);
                                    }
                                } else if (!line.startsWith('##') && line.length > 1 && line.length < 30) {
                                    // Raw list item without bullet
                                    const kw = line.replace(/\[\d+\]/g, '').replace(/\[|\]/g, '').trim();
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
 * Call Ollama API (Local LLM) for generating JSON
 */
function callOllama(prompt, model = 'gemma2:9b') {
    return new Promise((resolve, reject) => {
        const http = require('http');
        const data = JSON.stringify({ model, prompt, stream: false, format: 'json' });
        const options = {
            hostname: 'localhost', port: 11434, path: '/api/generate',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const cleaned = parsed.response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                    resolve(JSON.parse(cleaned));
                } catch (e) {
                    reject(new Error(`Ollama parsing failed: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
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
        log('🤖 Fetching real-time blog data to feed Gemini...');
        let recentBlogText = "";
        if (clientId && clientSecret) {
            try {
                const queries = ['요즘 뜨는 팝업스토어', '서울 신상 카페 가오픈', '주말 데이트 추천', '더현대 팝업', '성수동 팝업 예약'];
                for (const q of queries) {
                    const blogs = await searchNaverBlog(q, clientId, clientSecret, 15, 'sim');
                    const titles = blogs.map(b => b.title.replace(/<[^>]*>?/gm, '')).join(' | ');
                    recentBlogText += `[${q} 최신 블로그] ${titles}\n`;
                }
            } catch (e) {
                log(`⚠️ Failed to fetch recent blogs: ${e.message}`);
            }
        }

        log('🤖 Fetching live trends from LOCAL OLLAMA (gemma2:9b) with real-time blog data...');
        
        // Load Feedback Loop data
        const feedbackFile = require('path').join(__dirname, '..', 'data', 'feedback_loop.json');
        let feedbackText = '';
        if (fs.existsSync(feedbackFile)) {
            try {
                const feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8')).slice(-10); // get last 10
                if (feedbacks.length > 0) {
                    feedbackText = "\n\n## ⚠️ [매우 중요] 관리자 피드백 (오답 노트):\n과거에 당신이 추출한 핫플 이름 중 틀린 것을 관리자가 직접 수정한 내역입니다. 아래 실수를 절대 반복하지 마세요!\n";
                    feedbacks.forEach(f => {
                        feedbackText += `- 오답(당신이 추출했던 이름): "${f.original_name}" ➡️ 정답(관리자가 수정한 이름): "${f.corrected_name}" ${f.reason ? "(사유: " + f.reason + ")" : ""}\n`;
                    });
                    feedbackText += "이 오답 노트를 분석하여, 앞으로는 반드시 '정답'과 같은 깔끔하고 직관적인 스타일로만 상호명을 추출하세요.\n";
                }
            } catch(e) {}
        }

        const prompt = `당신은 한국의 로컬 검색 및 SNS 소셜 미디어 트렌드 분석 전문가입니다.${feedbackText}
현재 시간은 **2026년 8월**입니다.
한국(특히 서울)의 10대~30대 젊은층 사이에서 **가장 최근에 오픈했거나 이번 주에 폭발적으로 바이럴되고 있는 초신상 핫플레이스 키워드**를 카테고리별로 10개씩 찾아주세요.

## 최신 실시간 데이터 참고 (매우 중요):
아래는 방금 네이버 블로그 최신순 검색을 통해 수집한 가장 따끈따끈한 실시간 블로그 포스팅 제목들입니다.
이 네이버 실시간 데이터에 등장하는 핫플을 최우선으로 반영하되,

주의사항 1: 이미 너무 유명한 곳(아모레 성수, 더현대 서울, 런던베이글뮤지엄 등), 체인점, 혹은 이미 수십 번 뉴스에 나온 장소는 절대로 제외하세요.
주의사항 2: 이번 주에 갓 오픈한 초신상 팝업, 가오픈 식당, 팔로워가 적은 사람들 사이에서 '방금' 뜨기 시작한 마이크로 트렌드 장소를 최우선으로 발굴하세요.
, **반드시 당신의 구글 검색(Google Search Grounding) 능력도 함께 활용하여** 네이버 제목에는 없지만 현재 트위터/인스타 등에서 폭발적으로 유행 중인 최신 팝업과 핫플도 적극적으로 찾아내어 리스트를 보강하세요.
${recentBlogText}

## 중요 주의사항 (크리티컬 - 어길 시 실패):
1. **철저한 최신성**:
   - 과거부터 오랫동안 꾸준히 유명했던 장소(예: 카니랩, 어둠속의대화, 하우스오브바이닐, 롯데월드 교복 대여 등)는 **절대 포함하지 마세요**.
   - 반드시 **최근 1달 이내(가급적 최근 1~2주) 가오픈했거나 새로 시작한 팝업스토어, 신상 카페, 신규 전시**만 발굴해야 합니다.
2. **경험 및 구체성 중심**:
   - 팝업스토어나 전시의 경우, 행사의 길고 복잡한 공식 명칭 대신 **네이버/카카오 지도에서 사람들이 흔히 검색할 만한 가장 짧고 직관적인 핵심 상호명(핵심 브랜드명+지역 또는 팝업)**으로 요약해서 추출하세요. (예: 'STORY A 성수 : 뷰티서바이벌 살인사건' -> '아모레성수 뷰티서바이벌', '더현대 대구 팝업 : 박뚜기소금빵 , 픽베이크' -> '박뚜기소금빵 더현대대구', '[조말론] 씨솔트 앤 베르가못 팝업스토어' -> '조말론 성수 팝업'). 대괄호나 특수기호, 여러 브랜드 나열은 피하고 지도 검색에 최적화된 이름만 적으세요.
   - 단순히 '성수 카페'나 '홍대 공방' 같은 뻔한 지역 키워드는 제외하십시오.
   - **[매우 중요]** 일반적인 동네 밥집, 흔한 프랜차이즈, 평범한 고깃집이나 국밥집 등은 **절대 추출하지 마세요**. 인스타그래머블한 컨셉 다이닝, 특별한 웨이팅 맛집, 팝업 식당 등 **핫플레이스 성격이 강한 곳만** 엄선하세요.
3. **카테고리 중복 금지**:
   - 동일한 키워드를 여러 카테고리에 중복해서 넣지 마세요. 가장 성격이 잘 맞는 **단 하나의 카테고리**에만 배정해야 합니다. (예: 뷰티 팝업은 'popup'이나 'beauty' 중 하나에만 넣음)

## JSON Response Schema (오직 아래 포맷만 출력):
{
  "popup": ["상호명 팝업", ... 10개],
  "activity": ["상호명 공방", ... 10개],
  "beauty": ["상호명 스파", ... 10개],
  "dining": ["상호명 다이닝", ... 10개],
  "cafe": ["상호명 카페", ... 10개]
}
`;
    try {
        log('🧠 Fetching trends via BOTH Local Ollama and Cloud Gemini simultaneously...');
        const [ollamaResult, geminiResult] = await Promise.allSettled([
            callOllama(prompt),
            geminiApiKey ? makeGeminiRequest(prompt, geminiApiKey) : Promise.reject(new Error("No Gemini Key"))
        ]);

        dynamicKeywords = { popup: [], activity: [], beauty: [], dining: [], cafe: [] };
        let anySuccess = false;

        if (ollamaResult.status === 'fulfilled' && ollamaResult.value) {
            log('✅ Local Ollama extraction successful.');
            anySuccess = true;
            for (let k of Object.keys(dynamicKeywords)) {
                if (ollamaResult.value[k]) dynamicKeywords[k].push(...ollamaResult.value[k]);
            }
        } else {
            log(`⚠️ Ollama extraction failed: ${ollamaResult.reason?.message}`);
        }

        if (geminiResult.status === 'fulfilled' && geminiResult.value) {
            log('✅ Cloud Gemini extraction successful.');
            anySuccess = true;
            for (let k of Object.keys(dynamicKeywords)) {
                if (geminiResult.value[k]) dynamicKeywords[k].push(...geminiResult.value[k]);
            }
        } else {
            log(`⚠️ Gemini extraction failed: ${geminiResult.reason?.message}`);
        }

        if (!anySuccess) {
            dynamicKeywords = null;
        } else {
            // Deduplicate keywords within each category
            for (let k of Object.keys(dynamicKeywords)) {
                dynamicKeywords[k] = [...new Set(dynamicKeywords[k])];
            }
            
            // AI Filtering Step: Ask Gemini to clean the merged list of generic places
            if (geminiApiKey) {
                log('🧠 Asking Gemini to filter out generic restaurants & boring places from the merged list...');
                const filterPrompt = `아래는 로컬 핫플레이스 후보 키워드 목록(JSON)입니다.
1. "일반 동네 밥집, 백반집, 평범한 국밥/삼겹살집, 흔한 도서관/마트/프랜차이즈" 등 핫플레이스가 아닌 장소는 모두 배열에서 삭제하세요.
2. 각 팝업스토어나 핫플이 **어느 지역(예: 성수, 경주)** 혹은 **어느 건물(예: 더현대 서울, 롯데월드몰)**에서 열리는지 다음 블로그 원문을 참조하여 파악하세요.
[블로그 원문]
${recentBlogText}

3. 남은 핫플들의 키워드를 "상호명 | 지역명(또는 건물명)" 포맷의 문자열로 변환하여 배열에 담으세요. 만약 지역을 알 수 없으면 "상호명 | 미상" 으로 적으세요.
예시: "미피 팝업스토어 | 부산 영도", "스파이더맨 팝업 | 더현대 서울"
원래의 JSON 구조(popup, activity, beauty, dining, cafe)를 유지한 순수 JSON만 반환하세요.

${JSON.stringify(dynamicKeywords, null, 2)}`;
                try {
                    const filteredRes = await makeGeminiRequest(filterPrompt, geminiApiKey);
                    if (filteredRes && Object.keys(filteredRes).length > 0) {
                        dynamicKeywords = filteredRes;
                        log('✅ Gemini successfully filtered out generic places.');
                    }
                } catch (filterErr) {
                    log(`⚠️ Gemini filtering failed, using raw merged list: ${filterErr.message}`);
                }
            }
        }
    } catch (e) {
        log(`⚠️ Combined extraction failed: ${e.message}`);
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

        // 1. Add Gemini dynamic keywords
        if (dynamicKeywords && dynamicKeywords[cat.name]) {
            dynamicKeywords[cat.name].forEach(kw => {
                const cleaned = kw.trim();
                if (cleaned && !seen.has(cleaned)) {
                    seen.add(cleaned);
                    kwList.push(cleaned);
                }
            });
        }

        // 2. Fallbacks padding if we have less than 10 keywords
        if (kwList.length < 10) {
            const fallbacks = predefinedFallbacks[cat.name] || [];
            for (const fallback of fallbacks) {
                if (!seen.has(fallback)) {
                    seen.add(fallback);
                    kwList.push(fallback);
                    if (kwList.length >= 10) break;
                }
            }
        }

        // 3. Cap validation pool to maximum 15 keywords
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
                        keywordGroups: groupKeywords.map(kw => {
                            const pureName = kw.split('|')[0].trim();
                            return {
                                groupName: kw,
                                keywords: [...new Set([pureName, getShortKeyword(pureName)])]
                            };
                        }),
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
