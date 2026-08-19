const https = require('https');
https.get('https://m.place.naver.com/place/2020855313/home', r => {
    let d='';
    r.on('data', c=>d+=c);
    r.on('end', () => {
        const match = d.match(/"name":"([^"]+)"/g);
        console.log("Matches:", match ? match.slice(0, 5) : 'Not found');
    });
});
