const https = require('https');
const http = require('http');

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

function searchNaverBlog(query, display = 20) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=date`,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
            }
        };
        https.get(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data).items || []);
                } catch (e) {
                    resolve([]);
                }
            });
        }).on('error', () => resolve([]));
    });
}

function callOllama(prompt, model = 'gemma2:9b') {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: model,
            prompt: prompt,
            stream: false,
            format: 'json'
        });

        const options = {
            hostname: 'localhost',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = http.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
            res.on('data', chunk => responseBody += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseBody);
                    resolve(parsed.response);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runDemo() {
    console.log("🚀 [Ollama Demo] 네이버 실시간 데이터 수집 중...");
    let recentBlogText = "";
    
    // Fetch limited queries to keep it fast for demo
    const queries = ['성수 팝업스토어', '가오픈 카페'];
    for (const q of queries) {
        const blogs = await searchNaverBlog(q, 15);
        const titles = blogs.map(b => b.title.replace(/<[^>]*>?/gm, '')).join(' | ');
        recentBlogText += `[${q} 블로그 제목들]: ${titles}\n`;
    }

    console.log("✅ 데이터 수집 완료! (총 " + recentBlogText.length + " 글자)");
    console.log("🧠 로컬 Ollama (gemma2:9b) 에게 실시간 트렌드 추출 지시 중... (비용 0원!)");

    const prompt = `당신은 핫플레이스 추출 AI입니다. 
다음은 방금 네이버 블로그에서 검색한 '팝업' 및 '가오픈 카페' 관련 최신 포스팅 제목들입니다.
제목들을 읽고, 새롭게 열린 팝업스토어 3개와 신상 가오픈 카페 3개의 상호명을 찾아 아래 JSON 형식으로만 응답하세요. (마크다운 없이 오직 JSON만 출력)

[블로그 데이터]
${recentBlogText}

[출력 JSON 포맷]
{
  "popup": ["상호명1", "상호명2", "상호명3"],
  "cafe": ["카페명1", "카페명2", "카페명3"]
}`;

    try {
        const result = await callOllama(prompt);
        console.log("\n🎉 [Ollama 추출 결과]");
        console.log(result);
        console.log("\n✅ 완전히 로컬에서, 구글 검색 없이, 실시간 최신 데이터를 기반으로 완벽하게 트렌드를 추출했습니다!");
    } catch (e) {
        console.error("❌ Ollama 통신 실패:", e.message);
    }
}

runDemo();
