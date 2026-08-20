const fs = require('fs');
const https = require('https');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8').split('\n');
    for (let line of envConfig) {
        if (line && line.includes('=')) {
            const [k, v] = line.split('=');
            process.env[k.trim()] = v.trim();
        }
    }
}

const PLACES_FILE = path.join(__dirname, '..', 'data', 'places.json');

async function askGemini(prompt) {
    return new Promise((resolve) => {
        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) throw new Error(parsed.error.message);
                    const text = parsed.candidates[0].content.parts[0].text;
                    resolve(text);
                } catch (e) {
                    console.error("Gemini parse error:", e.message, "\nRaw response:", data);
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.write(requestBody);
        req.end();
    });
}

async function dedupe() {
    if (!fs.existsSync(PLACES_FILE)) return;
    const places = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
    
    // We only need to check recently added places against each other and existing ones.
    // For simplicity, let's just send the ones created recently (e.g. yesterday and today).
    // The user mentioned "어제 올라간 장소들도". Let's get places created >= 2026-08-19.
    const recentPlaces = places.filter(p => p.created_at >= '2026-08-19' && p.category === 'popup');
    
    if (recentPlaces.length === 0) {
        console.log("No recent popups to dedupe.");
        return;
    }

    console.log(`Checking ${recentPlaces.length} recent popups for semantic duplicates...`);

    const listStr = recentPlaces.map(p => `ID: ${p.id} | NAME: ${p.name_ko}`).join('\n');
    
    const prompt = `당신은 데이터 정제 전문가입니다.
아래는 최근 등록된 팝업스토어 및 전시 목록입니다.
이름에 줄임말이 섞여 있거나(예: '트오뷰'와 '트루스오브뷰티'), 띄어쓰기, 영문/한글 표기 차이, 수식어(예: 팝업, 전시회) 차이 등으로 인해 이름은 약간 다르지만 **완전히 동일한 행사/장소**인 것들을 묶어주세요.

예를 들어:
"빅뱅 2026-2027 월드투어 < XX : COSMOS > 공식 서울 팝업" 과 "빅뱅 2026 - 2027 월드투어 공식 서울 팝업" 은 동일합니다.
"트루스오브뷰티 별별 문방구 팝업" 과 "트오뷰 별별 문방구 뷰티팝업" 은 동일합니다.

출력 형식은 **오직 아래 JSON 형식**으로만 반환하세요 (마크다운 백틱 없이):
[
  {
    "duplicate_ids": ["id1", "id2"],
    "reason": "동일한 빅뱅 팝업"
  },
  ...
]
만약 중복이 없다면 빈 배열 [] 을 출력하세요.

목록:
${listStr}
`;

    const response = await askGemini(prompt);
    if (!response) {
        console.log("Failed to get response from Gemini.");
        return;
    }

    let groups = [];
    try {
        const cleaned = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        groups = JSON.parse(cleaned);
    } catch(e) {
        console.log("Failed to parse JSON from Gemini:", response);
        return;
    }

    let toDeleteIds = new Set();
    groups.forEach(group => {
        if (group.duplicate_ids.length > 1) {
            // Keep the first one, delete the rest
            const keep = group.duplicate_ids[0];
            const drop = group.duplicate_ids.slice(1);
            drop.forEach(id => toDeleteIds.add(id));
            console.log(`Merge: keeping '${keep}', dropping ${drop.join(', ')} (${group.reason})`);
        }
    });

    if (toDeleteIds.size > 0) {
        const newData = places.filter(p => !toDeleteIds.has(p.id));
        fs.writeFileSync(PLACES_FILE, JSON.stringify(newData, null, 2), 'utf8');
        console.log(`Deleted ${toDeleteIds.size} duplicate places.`);
    } else {
        console.log("No duplicates found to delete.");
    }
}

dedupe();
