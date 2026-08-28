/**
 * Kuromoon Pipeline — Gemini AI Data Refiner
 * 
 * Takes unstructured Korean text (blog posts, Instagram captions) and uses
 * the Google Gemini API to extract structured JSON matching places.json schema.
 * 
 * Usage: node pipeline/refine.js
 * Env:   GEMINI_API_KEY
 * Input: data/raw_inputs.json
 * Output: data/refined_places.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Configuration ---
const GEMINI_API_URL = 'generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const WEB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(WEB_DIR, 'data');
const INPUT_FILE = path.join(DATA_DIR, 'places_to_refine.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'places.json');

// Load .env if exists
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

// --- Utility Functions ---
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate URL-friendly slug from Korean or English name
 */

/**
 * Call Naver Local Search API to fetch official address
 */
function searchNaverLocal(query, clientId, clientSecret) {
    return new Promise((resolve) => {
        if (!clientId || !clientSecret || !query) return resolve([]);
        const https = require('https');
        const options = {
            hostname: 'openapi.naver.com',
            path: '/v1/search/local.json?query=' + encodeURIComponent(query) + '&display=1',
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.items || []);
                } catch(e) {
                    resolve([]);
                }
            });
        }).on('error', () => resolve([]));
    });
}

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^\w\s가-힣-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

/**
 * Map category string to Schema.org type
 */
function getSchemaType(category) {
    const map = {
        popup: 'Event',
        beauty: 'BeautySalon',
        medical: 'MedicalBusiness',
        dining: 'Restaurant',
        cafe: 'CafeOrCoffeeShop'
    };
    return map[category] || 'LocalBusiness';
}

function sanitizeCategory(category, placeName = '') {
    if (['popup', 'activity', 'beauty', 'dining', 'cafe'].includes(category)) {
        return category;
    }
    const name = placeName || '';
    if (name.includes('빙상장') || name.includes('스케이트') || name.includes('공방') || name.includes('클래스') || name.includes('체험') || name.includes('여행')) {
        return 'activity';
    }
    return 'popup';
}

/**
 * Build the extraction prompt for Gemini
 */
function buildPrompt(sourceText, category, referenceDate) {
    const refDateStr = referenceDate || new Date().toISOString().slice(0, 10);
    return `당신은 한국 로컬 비즈니스 데이터 전문 추출기입니다.
비정형 텍스트 분석 시 기준이 되는 날짜(오늘 또는 데이터 수집일)는 **${refDateStr}** 입니다.
텍스트 내에 "14일부터 20일까지", "다음 주 화요일", "이번 주 주말", "8월 14일 ~ 20일" 등 연도나 월이 생략되었거나 상대적인 날짜 표현이 나오는 경우, 이 기준 날짜인 **${refDateStr}**을 바탕으로 정확한 연도와 월을 유추하여 YYYY-MM-DD 형식으로 변환해야 합니다.

아래 비정형 텍스트에서 업체/이벤트 정보를 추출하여 **반드시 유효한 JSON만** 응답해주세요.
설명, 인사말, 마크다운 코드블록 없이 순수 JSON 객체만 출력하세요.

## 출력 JSON 형식:
{
  "name_ko": "상호명 (한국어. 반드시 네이버/카카오 지도에서 검색이 잘 되도록 부제나 수식어를 모두 뺀 가장 직관적이고 짧은 핵심 이름만 적으세요. 예: 'STORY A 뷰티서바이벌' -> '아모레성수 뷰티서바이벌', '더현대 대구 팝업 : 박뚜기소금빵 , 픽베이크' -> '박뚜기소금빵 더현대대구')",
  "name_en": "Business/Event Name (English translation)",
  "category": "${category}",
  "address_ko": "전체 주소 (한국어, 추출 가능하면 동/구 단위까지 명시)",
  "address_en": "Full address (English)",
  "startDate": "YYYY-MM-DD 또는 null",
  "endDate": "YYYY-MM-DD 또는 null",
  "hours": "영업시간 (예: 11:00 - 20:00)",
  "price_range": "가격대 (예: ₩6,000 ~ ₩12,000)",
  "reservation_url": "예약 링크 URL 또는 null",
  "instagram": "인스타그램 URL (https://www.instagram.com/계정/) 또는 null",
  "image": null,
  "tags": ["관련태그1", "관련태그2", "관련태그3"],
  "summary_ko": "한 줄 요약 (한국어, 30자 이내)",
  "summary_en": "One-line summary (English, under 80 chars)",
  "description_ko": "블로그 리뷰 내용을 바탕으로 작성된 1~4문장의 한국어 설명글. 정보가 충분할 경우 컨셉, 경험, 메뉴, 분위기 등을 서술하세요. 단, [매우 중요] 수집된 정보가 극도로 부족하여 상호명 외에 유의미한 설명을 작성할 수 없다면 절대 소설을 쓰지 말고 null을 반환하세요.",
  "description_en": "English experience summary of 1-4 sentences based on facts. If information is extremely insufficient, do not invent details and simply return null.",
  "foreign_friendly": true 또는 false,
  "parking": true 또는 false
}

## 규칙:
- 텍스트에 명시되지 않은 정보는 null로 표시
- 인스타그램 계정이 @username 형태면 https://www.instagram.com/username/ 으로 변환
- tags는 최소 2개, 최대 5개
- foreign_friendly는 외국인 관련 언급이 있으면 true
- parking은 주차 관련 언급이 있으면 해당 값, 없으면 false
- [중요] 장소의 이름만 보고 컨셉을 상상하거나 지어내지 마세요(예: '다크앤라이트'라는 이름만 보고 다크 다이닝으로 추측 금지). 반드시 제공된 블로그 텍스트(문맥)에 기반하여 실제 업종(예: 이탈리안 레스토랑, 팝업스토어 등)을 정확히 요약하세요.
- 설명글(description_ko, description_en) 및 요약글 작성 시, '정보가 명시되어 있지 않습니다', '확인할 수 없습니다', '언급되지 않았습니다' 등 정보의 부재를 설명하거나 변명하는 메타 해설 문장이나 괄호 처리를 절대로 포함하지 마세요. 오직 원문에 드러난 사실관계와 매력적인 정보로만 자연스러운 단락을 채우세요.
- 팝업스토어(popup), 축제(festival), 전시회(exhibition), 페어(fair) 등 기간이 정해진 행사인 경우 원문에서 진행 기간을 반드시 찾아서 startDate와 endDate에 YYYY-MM-DD 형식으로 기록하세요. (상시 영업인 경우만 null)
- 카테고리(category)는 반드시 다음 5가지 영문 키 중 하나만 지정하세요: popup, activity, beauty, dining, cafe. (전시회/축제/페어는 popup으로 지정하고, 원본 입력 카테고리가 유효하면 가급적 원본 카테고리를 유지하세요.)

## 분석할 텍스트:
"""
${sourceText}
"""`;
}

/**
 * Call Gemini API with retry logic
 */
function callGeminiAPI(prompt, apiKey) {
    return new Promise(async (resolve, reject) => {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const result = await makeGeminiRequest(prompt, apiKey);
                resolve(result);
                return;
            } catch (err) {
                log(`  ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
                if (attempt < MAX_RETRIES) {
                    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    log(`  ⏳ Retrying in ${delay}ms...`);
                    await sleep(delay);
                }
            }
        }
        reject(new Error(`All ${MAX_RETRIES} attempts failed`));
    });
}

/**
 * Make a single HTTP request to Gemini API
 */
function makeGeminiRequest(prompt, apiKey) {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 8192
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
                    reject(new Error(`API returned status ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                let text;
                try {
                    const response = JSON.parse(data);
                    console.log("FULL RESPONSE OBJECT:", JSON.stringify(response, null, 2));
                    text = response.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) {
                        reject(new Error('Empty response from Gemini'));
                        return;
                    }
                    // Parse the JSON from Gemini's response
                    // Remove markdown code block wrapper if present
                    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                    const parsed = JSON.parse(cleaned);
                    resolve(parsed);
                } catch (err) {
                    console.error("RAW TEXT WAS:", text);
                    reject(new Error(`Failed to parse Gemini response: ${err.message}`));
                }
            });
        });

        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}

/**
 * Validate required fields in extracted data
 */
function validatePlace(data) {
    const required = ['name_ko', 'category'];
    const missing = required.filter(f => !data[f]);
    if (missing.length > 0) {
        return { valid: false, reason: `Missing fields: ${missing.join(', ')}` };
    }
    return { valid: true };
}

/**
 * Main pipeline execution
 */
async function main() {
    log('═══════════════════════════════════════════');
    log('  Kuromoon Data Refiner — Gemini AI Pipeline');
    log('═══════════════════════════════════════════');

    // Check API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        log('❌ ERROR: GEMINI_API_KEY environment variable is not set.');
        log('   Set it with: set GEMINI_API_KEY=your_key_here');
        log('');
        log('💡 Generating DEMO output with sample data instead...');
        generateDemoOutput();
        return;
    }

    // Read raw inputs
    if (!fs.existsSync(INPUT_FILE)) {
        log(`ℹ️ places_to_refine.json not found. Skipping refinement.`);
        return;
    }

    const rawInputs = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
    log(`📄 Loaded ${rawInputs.length} place(s) to refine from places_to_refine.json`);

    if (rawInputs.length === 0) {
        log('ℹ️ No places to refine. Skipping.');
        return;
    }

    // Load existing places.json to append to it
    let existingPlaces = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            existingPlaces = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        } catch (e) {
            log(`⚠️ Warning: Failed to parse places.json: ${e.message}`);
        }
    }

    const results = [];

    for (let i = 0; i < rawInputs.length; i++) {
        const input = rawInputs[i];
        log(`\n🔄 Processing [${i + 1}/${rawInputs.length}]: category="${input.category}"`);
        
        if (input.is_already_refined && input.existing_place_data) {
            log(`  ♻️  Already refined in database: "${input.existing_place_data.name_ko}" — skipping Gemini refinement`);
            const place = {
                ...input.existing_place_data,
                review_count: input.review_count,
                weekly_review_count: input.weekly_review_count,
                biweekly_review_count: input.biweekly_review_count,
                recent_snippets: input.recent_snippets
            };
            results.push(place);
            continue;
        }

        const sourceText = input.source_text || '';
        log(`   Text preview: "${sourceText.substring(0, 60)}..."`);

        try {
            const refDate = input.created_at || new Date().toISOString().slice(0, 10);
            const prompt = buildPrompt(input.source_text, input.category, refDate);
            const extracted = await callGeminiAPI(prompt, apiKey);

            // Validate
            const validation = validatePlace(extracted);
            if (!validation.valid) {
                log(`  ⚠ Validation failed: ${validation.reason} — skipping`);
                continue;
            }

            // Generate ID and set schema type
            
            // [NEW] Call Naver Local API to standardize address
            const clientId = process.env.NAVER_CLIENT_ID;
            const clientSecret = process.env.NAVER_CLIENT_SECRET;
            
            if (clientId && clientSecret) {
                let foundByName = true;
                let localResults = await searchNaverLocal(extracted.name_ko, clientId, clientSecret);
                
                // Fallback: If not found by name, try searching by the AI-guessed address (often finds the building/venue)
                if (localResults.length === 0 && extracted.address_ko) {
                    foundByName = false;
                    const shortAddr = extracted.address_ko.split(' ').slice(0, 3).join(' '); // e.g. "서울 성동구 연무장길"
                    localResults = await searchNaverLocal(shortAddr, clientId, clientSecret);
                }

                if (localResults.length > 0) {
                    const official = localResults[0];
                    const officialAddress = official.roadAddress || official.address;
                    if (officialAddress) {
                        extracted.address_ko = officialAddress;
                        log(`   📍 Naver Local API Match: Standardized address to "${officialAddress}"`);
                    }
                    if (foundByName && official.title) {
                        const officialTitle = official.title.replace(/<[^>]+>/g, '').trim(); // Strip HTML tags like <b>
                        log(`   🏷️ Naver Local API Match: Standardized name from "${extracted.name_ko}" to "${officialTitle}"`);
                        extracted.name_ko = officialTitle;
                    }

                    // [NEW] API Cross-Validation for Category Hallucination
                    if (foundByName && official.category) {
                        const navCat = official.category; // e.g., "음식점>이탈리아음식"
                        const aiCat = extracted.category || input.category;
                        
                        log(`   🔎 Naver Official Category: "${navCat}" | AI Category: "${aiCat}"`);
                        
                        let hallucinationDetected = false;
                        
                        if (aiCat === 'dining' && (navCat.includes('학원') || navCat.includes('교육') || navCat.includes('미술') || navCat.includes('전시') || navCat.includes('미용') || navCat.includes('숙박'))) {
                            log(`   ❌ [Hallucination Detected] AI guessed 'dining' but API says '${navCat}'. Reverting to 'activity'.`);
                            extracted.category = 'activity';
                            hallucinationDetected = true;
                        }
                        else if (aiCat === 'beauty' && (navCat.includes('음식점') || navCat.includes('카페') || navCat.includes('제과'))) {
                            log(`   ❌ [Hallucination Detected] AI guessed 'beauty' but API says '${navCat}'. Reverting to 'dining'.`);
                            extracted.category = 'dining';
                            hallucinationDetected = true;
                        }
                        else if (aiCat === 'cafe' && !(navCat.includes('음식점') || navCat.includes('카페') || navCat.includes('제과'))) {
                            log(`   ❌ [Hallucination Detected] AI guessed 'cafe' but API says '${navCat}'. Reverting to 'activity'.`);
                            extracted.category = 'activity';
                            hallucinationDetected = true;
                        }

                        if (hallucinationDetected) {
                            extracted.summary_ko = null;
                            extracted.summary_en = null;
                            extracted.description_ko = null;
                            extracted.description_en = null;
                            extracted.confidence_score = Math.max(10, (input.confidence_score || 100) - 50);
                        }
                    }
                } else {
                    log(`   ⚠️ Naver Local API No Match: Keeping AI generated address "${extracted.address_ko}"`);
                }
            }
            
            const finalCat = sanitizeCategory(extracted.category || input.category, extracted.name_ko);
            const id = input.id || generateSlug(extracted.name_en || extracted.name_ko);
            let initialStatus = extracted.operating_status || input.operating_status || '운영 중';
            const startDateStr = extracted.startDate || input.startDate;
            const endDateStr = extracted.endDate || input.endDate;
            if (startDateStr && endDateStr) {
                const todayStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
                if (todayStr > endDateStr) {
                    initialStatus = '행사 종료';
                } else if (todayStr < startDateStr) {
                    initialStatus = '행사 예정';
                } else {
                    initialStatus = '행사 중';
                }
            }

            const place = {
                id: id,
                type: getSchemaType(finalCat),
                ...extracted,
                name_ko: (input.name_ko && input.name_ko.trim()) ? input.name_ko.trim() : extracted.name_ko,
                category: finalCat,
                review_count: input.review_count || 0,
                weekly_review_count: input.weekly_review_count || 0,
                biweekly_review_count: input.biweekly_review_count || 0,
                recent_snippets: input.recent_snippets || [],
                confidence_score: input.confidence_score || 0,
                operating_status: initialStatus,
                last_status_checked_at: new Date().toISOString().slice(0, 10),
                created_at: input.created_at || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
                updated_at: input.updated_at || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
            };

            results.push(place);
            log(`  ✅ Extracted: "${place.name_ko}" (${place.name_en})`);
        } catch (err) {
            log(`  ❌ Failed to process: ${err.message}`);
        }

        // Rate limiting: wait 1s between requests
        if (i < rawInputs.length - 1) {
            await sleep(1000);
        }
    }

    // Save results (deduplicate by id)
    const combinedMap = new Map();
    existingPlaces.forEach(p => combinedMap.set(p.id, p));
    results.forEach(p => combinedMap.set(p.id, p)); // Results overwrite existing
    const combined = Array.from(combinedMap.values());
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(combined, null, 2), 'utf8');
    log(`\n✅ Saved ${results.length} newly refined place(s) to places.json (Total published: ${combined.length})`);
    
    // Clean up places_to_refine.json
    try {
        fs.writeFileSync(INPUT_FILE, JSON.stringify([], null, 2), 'utf8');
    } catch (e) {}
    log('═══════════════════════════════════════════');
}

/**
 * Generate demo output when no API key is available
 */
function generateDemoOutput() {
    const demoData = [
        {
            id: 'musinsa-standard-popup-seongsu',
            type: 'Event',
            category: 'popup',
            name_ko: '무신사 스탠다드 성수 팝업',
            name_en: 'Musinsa Standard Seongsu Pop-up',
            address_ko: '서울특별시 성동구 성수이로 78 대림창고',
            address_en: '78 Seongsui-ro, Seongdong-gu, Seoul (Daelim Warehouse)',
            startDate: '2026-07-10',
            endDate: '2026-07-24',
            hours: '11:00 - 20:00',
            price_range: '무료입장 (Free Entry)',
            reservation_url: 'https://booking.naver.com/musinsa-popup',
            instagram: 'https://instagram.com/musinsa_standard',
            image: null,
            tags: ['팝업스토어', '포토존', '한정판굿즈', '무료입장', '성수동'],
            summary_ko: '포토존 5개와 한정판 굿즈가 있는 무신사 팝업',
            summary_en: 'Musinsa pop-up with 5 photo zones and limited edition goods',
            foreign_friendly: true,
            parking: false,
            confidence_score: 0
        },
        {
            id: 'moonlight-garden-cafe-hannam',
            type: 'CafeOrCoffeeShop',
            category: 'cafe',
            name_ko: '달빛정원',
            name_en: 'Moonlight Garden Cafe',
            address_ko: '서울특별시 용산구 한남대로 42길 30',
            address_en: '30 Hannam-daero 42-gil, Yongsan-gu, Seoul',
            startDate: null,
            endDate: null,
            hours: '10:00 - 23:00 (Mon Closed)',
            price_range: '₩6,000 ~ ₩10,000',
            reservation_url: null,
            instagram: 'https://instagram.com/moonlight_garden_cafe',
            image: null,
            tags: ['콘센트많음', '루프탑', '반려동물동반', '한강뷰', '디저트'],
            summary_ko: '한강이 보이는 루프탑 디저트 카페',
            summary_en: 'Rooftop dessert cafe with Han River views',
            foreign_friendly: false,
            parking: true,
            confidence_score: 0
        }
    ];

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(demoData, null, 2), 'utf8');
    log(`✅ Demo output saved with ${demoData.length} sample place(s) to refined_places.json`);
}

// Export for server.js use
async function refineSinglePlace(input, apiKey) {
    let sourceText = input.source_text;
    if (!sourceText) {
        log(`[API] Place '${input.name_ko}' is missing source_text. Attempting real-time blog search...`);
        try {
            const query = getPreciseQuery(input.name_ko, input.address_ko, input.category);
            const blogRes = await searchNaverBlog(query, 4, 'sim');
            const blogItems = blogRes.items || [];
            
            if (blogItems.length > 0) {
                const reviewTexts = blogItems.map((item, bIdx) => {
                    const cleanTitle = cleanHtml(item.title);
                    const cleanDesc = cleanHtml(item.description);
                    return `[리뷰 ${bIdx + 1}]\n제목: ${cleanTitle}\n내용: ${cleanDesc}`;
                }).join('\n\n');
                
                sourceText = `검색 키워드: ${query}
실제 지도 상호명: ${input.name_ko}
실제 지도 도로명 주소: ${input.address_ko}
카테고리: ${input.category}

${reviewTexts}`;
                log(`[API] Successfully fetched ${blogItems.length} blog(s) for real-time refinement.`);
            } else {
                log(`[API] No blogs found for query '${query}'. Using fallback schema generator.`);
            }
        } catch (err) {
            log(`[API] Failed to fetch blogs: ${err.message}. Using fallback schema generator.`);
        }
    }

    let prompt;
    if (sourceText) {
        const refDate = input.created_at || new Date().toISOString().slice(0, 10);
        prompt = buildPrompt(sourceText, input.category, refDate);
    } else {
        const cleanTags = Array.isArray(input.tags) && input.tags.length > 0 ? input.tags : ["로컬", "추천", "가볼만한곳"];
        prompt = `당신은 한국 로컬 비즈니스 데이터 전문 추출기입니다.
아래 주어진 기본 정보를 바탕으로 **반드시 유효한 JSON만** 응답해주세요.
설명, 인사말, 마크다운 코드블록 없이 순수 JSON 객체만 출력하세요.

## 주어진 정보:
- 상호명 (한국어): "${input.name_ko}"
- 영어 상호명 (유추): "${input.name_en || ''}"
- 주소 (한국어): "${input.address_ko || ''}"
- 주소 (영어, 유추): "${input.address_en || ''}"
- 카테고리: "${input.category}"
- 영업시간: "${input.hours || ''}"
- 가격대: "${input.price_range || ''}"
- 인스타그램: "${input.instagram || ''}"
- 태그: ${JSON.stringify(cleanTags)}
- 한 줄 요약 (한국어): "${input.summary_ko || ''}"
- 한 줄 요약 (영어): "${input.summary_en || ''}"

## 출력 JSON 형식:
{
  "name_ko": "${input.name_ko}",
  "name_en": "영어 상호명 (유추)",
  "category": "${input.category}",
  "address_ko": "${input.address_ko || ''}",
  "address_en": "영어 주소 (유추)",
  "startDate": null,
  "endDate": null,
  "hours": ${input.hours ? `"${input.hours}"` : 'null'},
  "price_range": ${input.price_range ? `"${input.price_range}"` : 'null'},
  "reservation_url": null,
  "instagram": ${input.instagram ? `"${input.instagram}"` : 'null'},
  "image": null,
  "tags": ${JSON.stringify(cleanTags)},
  "summary_ko": "${input.summary_ko || ''}",
  "summary_en": "${input.summary_en || ''}",
  "description_ko": "블로그 리뷰 내용을 바탕으로 작성된 1~4문장의 한국어 설명글. 정보가 극도로 부족하다면 상상해서 쓰지 말고 null을 반환하세요.",
  "description_en": "English experience summary of 1-4 sentences based on facts. If information is extremely insufficient, return null.",
  "foreign_friendly": ${input.foreign_friendly || false},
  "parking": ${input.parking || false}
}

## 규칙:
- name_en, address_en 필드는 가급적 채우되, description_ko, description_en, summary_ko, summary_en은 정보가 극도로 부족할 경우 소설을 쓰지 말고 null로 두세요.
- 설명글 작성 시 '정보가 명시되어 있지 않습니다', '확인할 수 없습니다' 등의 메타적 해설을 절대 포함하지 마세요.
- [중요] 장소의 상호명만 보고 임의로 컨셉을 지어내거나 추측하지 마세요(예: '다크앤라이트'라는 이름만 보고 다크 다이닝으로 추측 금지). 주어진 태그, 카테고리, 이미 알려진 사실 기반으로만 정확하게 묘사하세요.`;
    }

    const extracted = await callGeminiAPI(prompt, apiKey);
    const validation = validatePlace(extracted);
    if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.reason}`);
    }
    const finalCat = sanitizeCategory(extracted.category || input.category, extracted.name_ko);
    const id = input.id || generateSlug(extracted.name_en || extracted.name_ko);
    return {
        id: id,
        type: getSchemaType(finalCat),
        ...extracted,
        name_ko: (input.name_ko && input.name_ko.trim()) ? input.name_ko.trim() : extracted.name_ko,
        category: finalCat,
        review_count: input.review_count || 0,
        weekly_review_count: input.weekly_review_count || 0,
        biweekly_review_count: input.biweekly_review_count || 0,
        recent_snippets: input.recent_snippets || [],
        confidence_score: input.confidence_score || 0,
        last_status_checked_at: new Date().toISOString().slice(0, 10),
        created_at: input.created_at || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
        updated_at: input.updated_at || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    };
}

// --- Naver Blog API & Text Helpers ---
function cleanHtml(str) {
    if (!str) return '';
    return str
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function getPreciseQuery(placeName, address, category) {
    const cleanName = placeName.trim();
    if (cleanName.length >= 6 || cleanName.includes('점') || cleanName.includes('지점')) {
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
            beauty: '웰니스',
            dining: '맛집',
            cafe: '카페'
        };
        suffix = ' ' + (suffixMap[category] || '');
    }
    
    return `${region}${cleanName}${suffix}`.trim();
}

function searchNaverBlog(query, display = 4, sort = 'sim') {
    return new Promise((resolve, reject) => {
        const clientId = process.env.NAVER_CLIENT_ID;
        const clientSecret = process.env.NAVER_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            return reject(new Error('Naver client keys not configured'));
        }
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
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

if (require.main === module) {
    main().catch(err => {
        log(`❌ Fatal error: ${err.message}`);
        process.exit(1);
    });
} else {
    module.exports = { refineSinglePlace };
}
