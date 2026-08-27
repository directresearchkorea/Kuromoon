const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const apiKey = env.match(/GEMINI_API_KEY=(.*)/)[1].trim();
const https = require('https');
const prompt = `당신은 한국의 로컬 검색 및 SNS 소셜 미디어 트렌드 분석 전문가입니다. 한국(특히 서울)의 10대~30대 젊은층 사이에서 가장 최근에 오픈했거나 이번 주에 폭발적으로 바이럴되고 있는 초신상 핫플레이스 키워드를 카테고리별로 10개씩 찾아주세요. JSON Response Schema (오직 아래 포맷만 출력): { "popup": ["상호명 팝업", ... 10개], "activity": ["상호명 공방", ... 10개], "beauty": ["상호명 스파", ... 10개], "dining": ["상호명 다이닝", ... 10개], "cafe": ["상호명 카페", ... 10개] }`;
const requestBody = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
};
const req = https.request(options, res => {
    let d = ''; res.on('data', c => d+=c); res.on('end', () => console.log('Finished!', d.length, 'bytes', d.substring(0,200)));
});
req.on('error', console.error);
req.write(requestBody);
req.end();
