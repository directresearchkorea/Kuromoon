function searchNaverBlog(query, clientId, clientSecret, display = 20, sort = 'date') {
    return new Promise((resolve, reject) => {
        if (!clientId || !clientSecret) return resolve([]);
        const https = require('https');
        const options = {
            hostname: 'openapi.naver.com',
            path: `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`,
            method: 'GET',
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
        };
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve([]);
                try { resolve(JSON.parse(data).items || []); } catch (e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}
module.exports = { searchNaverBlog };
