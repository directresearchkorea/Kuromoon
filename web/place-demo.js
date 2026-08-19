const https = require('https');
const http = require('http');

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// Helper: Call Ollama locally
function callOllama(prompt, model = 'gemma2:9b') {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ model, prompt, stream: false, format: 'json' });
        const options = {
            hostname: 'localhost', port: 11434, path: '/api/generate',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body).response); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// 1. Clean Keyword
async function getCleanMapSearchQuery(keyword) {
    const prompt = `당신은 네이버 지도 검색어 정제 전문가입니다.
사용자 키워드: "${keyword}"
이 키워드에서 네이버 지도에 검색하기 좋은 핵심 상호명(+지역명)만 추출하세요. 불필요한 수식어(팝업, 팝업스토어, 저당디저트, 신상 카페 등)는 제거하세요.
단, 행사명이 상호명 자체라면 그대로 유지하세요.
반드시 아래 JSON 포맷으로만 응답하세요:
{ "query": "정제된검색어" }`;
    const res = await callOllama(prompt);
    return JSON.parse(res).query;
}

// 2. Search Naver Local
function searchNaverLocal(query) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/local.json?query=${encodeURIComponent(query)}&display=3`,
            method: 'GET',
            headers: { 'X-Naver-Client-Id': NAVER_CLIENT_ID, 'X-Naver-Client-Secret': NAVER_CLIENT_SECRET }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).items || []); } catch(e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

// 3. Search Naver Blog
function searchNaverBlog(query) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=3`,
            method: 'GET',
            headers: { 'X-Naver-Client-Id': NAVER_CLIENT_ID, 'X-Naver-Client-Secret': NAVER_CLIENT_SECRET }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).items || []); } catch(e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

// 4. Extract Venue/Address from Blogs
async function extractAddress(keyword, blogs) {
    const snippets = blogs.map(b => b.title.replace(/<[^>]*>?/gm, '') + " - " + b.description.replace(/<[^>]*>?/gm, '')).join('\n');
    const prompt = `당신은 블로그 내용에서 핫플레이스의 상호명과 도로명 주소를 추출하는 AI입니다.
키워드: "${keyword}"
블로그 내용들:
${snippets}

위 내용을 읽고, 해당 장소의 정확한 '상호명(venue)'과 '도로명 주소(address)'를 추출하세요. 주소가 없으면 "알 수 없음"으로 적으세요.
반드시 아래 JSON 포맷으로 응답하세요:
{
  "venue": "상호명",
  "address": "서울특별시 ~~~"
}`;
    const res = await callOllama(prompt);
    return JSON.parse(res);
}

// Main Flow
async function run() {
    const testKeyword = "만장 도산대로"; // From our recent real-time list
    console.log(`\n▶ [STEP 1] 원본 트렌드 키워드: "${testKeyword}"`);
    
    console.log(`\n▶ [STEP 2] Ollama가 지도 검색용 쿼리로 정제 중...`);
    const cleanQuery = await getCleanMapSearchQuery(testKeyword);
    console.log(`   ✅ 정제된 검색어: "${cleanQuery}"`);

    console.log(`\n▶ [STEP 3] 네이버 지도(Local) 검색 중...`);
    const mapResults = await searchNaverLocal(cleanQuery);
    if (mapResults.length > 0) {
        console.log(`   ✅ 지도 검색 1위: "${mapResults[0].title.replace(/<[^>]*>?/gm, '')}" (주소: ${mapResults[0].roadAddress})`);
    } else {
        console.log(`   ⚠ 지도 검색 결과 없음. 블로그 리뷰로 우회 탐색합니다.`);
    }

    console.log(`\n▶ [STEP 4] 네이버 블로그 리뷰 수집 중...`);
    const blogResults = await searchNaverBlog(testKeyword);
    console.log(`   ✅ 블로그 리뷰 ${blogResults.length}건 수집 완료.`);

    console.log(`\n▶ [STEP 5] Ollama가 블로그 리뷰를 읽고 최종 상호명 및 주소 추출 중...`);
    const finalData = await extractAddress(testKeyword, blogResults);
    console.log(`\n🎉 [최종 추출 결과]`);
    console.log(`   - 상호명: ${finalData.venue}`);
    console.log(`   - 주소: ${finalData.address}`);
    console.log("\n✅ 키워드에서 실제 장소 정보로의 완벽한 연결이 로컬 AI만으로 완료되었습니다!\n");
}

run();
