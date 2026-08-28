const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const apiKey = env.match(/GEMINI_API_KEY=(.*)/)[1].trim();
const https = require('https');
const prompt = `한국 핫플레이스 3개`;
const requestBody = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
};
const req = https.request(options, res => {
    let d = ''; res.on('data', c => d+=c); res.on('end', () => console.log('Finished!', d.substring(0,300)));
});
req.on('error', console.error);
req.write(requestBody);
req.end();
