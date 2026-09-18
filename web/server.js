const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const WEB_DIR = __dirname;
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const DATA_DIR = path.join(WEB_DIR, 'data');

// Load .env
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

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function isSafeOrigin(req) {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    if (origin && !allowed.some(a => origin.startsWith(a))) return false;
    if (referer && !allowed.some(a => referer.startsWith(a))) return false;
    return true;
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // Basic Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // Decode URI safely
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(req.url);
    } catch(e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
    }
    const urlWithoutQuery = decodedUrl.split('?')[0];
    
    // API routes for Approving/Discarding pending places
    if (req.method === 'POST') {
        if (!isSafeOrigin(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: Untrusted origin' }));
            return;
        }
        if (urlWithoutQuery === '/api/approve-place' || urlWithoutQuery === '/api/discard-place') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const { id, corrected_name } = payload;
                    if (!id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing place ID' }));
                        return;
                    }

                    const dataDir = path.join(WEB_DIR, 'data');
                    const reviewFile = path.join(dataDir, 'review_needed.json');
                    const placesFile = path.join(dataDir, 'places.json');
                    const discardedFile = path.join(dataDir, 'discarded_places.json');

                    let reviewPlaces = [];
                    if (fs.existsSync(reviewFile)) {
                        reviewPlaces = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
                    }

                    const placeIndex = reviewPlaces.findIndex(p => p.id === id);
                    if (placeIndex === -1) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Place not found in review_needed' }));
                        return;
                    }

                    const place = reviewPlaces[placeIndex];

                    if (urlWithoutQuery === '/api/approve-place') {
                        let places = [];
                        if (fs.existsSync(placesFile)) {
                            places = JSON.parse(fs.readFileSync(placesFile, 'utf8'));
                        }

                        // Since this is a raw map place from review_needed.json, we must refine it using Gemini AI in real-time!
                        const apiKey = process.env.GEMINI_API_KEY;
                        if (!apiKey) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
                            return;
                        }

                        
                        if (corrected_name) {
                            log(`[API] User corrected name: '${place.name_ko}' -> '${corrected_name}'. Saving to feedback loop.`);
                            const feedbackFile = path.join(dataDir, 'feedback_loop.json');
                            let feedbacks = [];
                            if (fs.existsSync(feedbackFile)) {
                                try { feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8')); } catch(e) {}
                            }
                            feedbacks.push({
                                timestamp: new Date().toISOString(),
                                original_name: place.name_ko,
                                corrected_name: corrected_name
                            });
                            // Keep only last 100 feedbacks to avoid bloat
                            if (feedbacks.length > 100) feedbacks = feedbacks.slice(-100);
                            fs.writeFileSync(feedbackFile, JSON.stringify(feedbacks, null, 2), 'utf8');
                            
                            // Update the place name before refinement
                            place.name_ko = corrected_name;
                        }

                        log(`[API] Refining place '${place.name_ko}' with Gemini AI in real-time...`);
                        const { refineSinglePlace } = require(path.join(WEB_DIR, 'pipeline', 'refine.js'));
                        
                        let refinedPlace;
                        try {
                            refinedPlace = await refineSinglePlace(place, apiKey);
                        } catch (refineErr) {
                            console.error(`[API] Gemini refinement failed: ${refineErr.message}`);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `Gemini refinement failed: ${refineErr.message}` }));
                            return;
                        }

                        // Move to places.json (avoid duplicates)
                        const existingIdx = places.findIndex(p => p.id === refinedPlace.id);
                        const todayStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
                        if (existingIdx !== -1) {
                            places[existingIdx] = { ...places[existingIdx], ...refinedPlace, updated_at: todayStr };
                        } else {
                            if (!refinedPlace.created_at) refinedPlace.created_at = todayStr;
                            refinedPlace.updated_at = todayStr;
                            places.push(refinedPlace);
                        }

                        reviewPlaces.splice(placeIndex, 1);

                        fs.writeFileSync(placesFile, JSON.stringify(places, null, 2), 'utf8');
                        fs.writeFileSync(reviewFile, JSON.stringify(reviewPlaces, null, 2), 'utf8');

                        // Rebuild static pages and sitemap
                        try {
                            const { execSync } = require('child_process');
                            execSync(`node "${path.join(WEB_DIR, 'build.js')}"`, { stdio: 'inherit' });
                            execSync(`node "${path.join(WEB_DIR, 'pipeline', 'generate-seo.js')}"`, { stdio: 'inherit' });
                            log(`[API] Rebuilt site successfully for approved place: ${refinedPlace.id}`);
                        } catch (buildErr) {
                            console.error(`[API] Error rebuilding site: ${buildErr.message}`);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Place approved and site rebuilt' }));
                    } else {
                        // Discard
                        let discardedPlaces = [];
                        if (fs.existsSync(discardedFile)) {
                            discardedPlaces = JSON.parse(fs.readFileSync(discardedFile, 'utf8'));
                        }

                        if (!discardedPlaces.some(p => p.id === id)) {
                            place.discard_reason = payload.discard_reason || 'Manual rejection via Dashboard';
                            discardedPlaces.push(place);
                        }
                        
                        // Save to feedback_loop.json for AI to learn
                        if (payload.discard_reason && payload.original_name) {
                            const feedbackFile = path.join(dataDir, 'feedback_loop.json');
                            let feedbacks = [];
                            if (fs.existsSync(feedbackFile)) {
                                try { feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8')); } catch(e) {}
                            }
                            feedbacks.push({
                                timestamp: new Date().toISOString(),
                                original_name: payload.original_name,
                                corrected_name: '[완전 폐기]',
                                reason: payload.discard_reason
                            });
                            if (feedbacks.length > 100) feedbacks = feedbacks.slice(-100);
                            fs.writeFileSync(feedbackFile, JSON.stringify(feedbacks, null, 2), 'utf8');
                            log(`[API] Added discard reason to feedback loop: ${payload.original_name} - ${payload.discard_reason}`);
                        }

                        reviewPlaces.splice(placeIndex, 1);

                        fs.writeFileSync(discardedFile, JSON.stringify(discardedPlaces, null, 2), 'utf8');
                        fs.writeFileSync(reviewFile, JSON.stringify(reviewPlaces, null, 2), 'utf8');

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Place discarded successfully' }));
                    }

                } catch (parseErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                }
            });
            return;
        } else if (urlWithoutQuery === '/api/update-place') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const { id, statusGroup, category, summary_ko, description_ko, operating_status } = payload;
                    if (!id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'Missing place ID' }));
                    }

                    const dataDir = path.join(WEB_DIR, 'data');
                    const reviewFile = path.join(dataDir, 'review_needed.json');
                    const placesFile = path.join(dataDir, 'places.json');

                    let reviewPlaces = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : [];
                    let places = fs.existsSync(placesFile) ? JSON.parse(fs.readFileSync(placesFile, 'utf8')) : [];

                    let place = null;
                    if (statusGroup === 'published') {
                        const idx = places.findIndex(p => p.id === id);
                        if (idx > -1) {
                            place = places[idx];
                            place.category = category;
                            place.summary_ko = summary_ko;
                            place.description_ko = description_ko;
                            place.operating_status = operating_status;
                            fs.writeFileSync(placesFile, JSON.stringify(places, null, 2), 'utf8');
                        }
                    } else {
                        const idx = reviewPlaces.findIndex(p => p.id === id);
                        if (idx > -1) {
                            place = reviewPlaces[idx];
                            place.category = category;
                            place.summary_ko = summary_ko;
                            place.description_ko = description_ko;
                            place.operating_status = operating_status;
                            place.confidence_score = 100; // auto-approve after manual edit
                            
                            places.push(place);
                            reviewPlaces.splice(idx, 1);
                            
                            fs.writeFileSync(placesFile, JSON.stringify(places, null, 2), 'utf8');
                            fs.writeFileSync(reviewFile, JSON.stringify(reviewPlaces, null, 2), 'utf8');
                        }
                    }

                    if (!place) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'Place not found' }));
                    }

                    // Rebuild
                    try {
                        const { execSync } = require('child_process');
                        execSync(`node "${path.join(WEB_DIR, 'build.js')}"`, { stdio: 'inherit' });
                        log(`[API] Rebuilt site successfully for updated place: ${place.id}`);
                    } catch (buildErr) {
                        console.error(`[API] Error rebuilding site: ${buildErr.message}`);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        } else if (urlWithoutQuery === '/api/delete-place') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const { id, original_name, discard_reason } = payload;
                    if (!id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing place ID' }));
                        return;
                    }

                    const dataDir = path.join(WEB_DIR, 'data');
                    const placesFile = path.join(dataDir, 'places.json');

                    let places = [];
                    if (fs.existsSync(placesFile)) {
                        places = JSON.parse(fs.readFileSync(placesFile, 'utf8'));
                    }

                    const placeIndex = places.findIndex(p => p.id === id);
                    if (placeIndex === -1) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Place not found' }));
                        return;
                    }

                    places.splice(placeIndex, 1);
                        
                        // Save to feedback_loop.json
                        if (discard_reason && original_name) {
                            const feedbackFile = path.join(dataDir, 'feedback_loop.json');
                            let feedbacks = [];
                            if (fs.existsSync(feedbackFile)) {
                                try { feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8')); } catch(e) {}
                            }
                            feedbacks.push({
                                timestamp: new Date().toISOString(),
                                original_name: original_name,
                                corrected_name: '[완전 삭제]',
                                reason: discard_reason
                            });
                            if (feedbacks.length > 100) feedbacks = feedbacks.slice(-100);
                            fs.writeFileSync(feedbackFile, JSON.stringify(feedbacks, null, 2), 'utf8');
                            log(`[API] Added delete reason to feedback loop: ${original_name} - ${discard_reason}`);
                        }
                    fs.writeFileSync(placesFile, JSON.stringify(places, null, 2), 'utf8');

                    // Rebuild site
                    try {
                        const { execSync } = require('child_process');
                        execSync(`node "${path.join(WEB_DIR, 'build.js')}"`, { stdio: 'inherit' });
                        execSync(`node "${path.join(WEB_DIR, 'pipeline', 'generate-seo.js')}"`, { stdio: 'inherit' });
                        log(`[API] Rebuilt site successfully after deleting place: ${id}`);
                    } catch (buildErr) {
                        console.error(`[API] Error rebuilding site: ${buildErr.message}`);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Place deleted successfully' }));
                } catch (parseErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                }
            });
            return;
        }
    }

    // Allow only GET and HEAD for static files
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    let filePath;

    // Handle dashboard aliases
    if (urlWithoutQuery === '/' || urlWithoutQuery === '/dashboard' || urlWithoutQuery === '/dashboard.html' || urlWithoutQuery === '/public/dashboard.html') {
        filePath = path.join(PUBLIC_DIR, 'dashboard.html');
    } else if (urlWithoutQuery.startsWith('/data/')) {
        // Whitelist for specific JSON data files needed by the dashboard
        const dataMatch = urlWithoutQuery.match(/^\/data\/([a-zA-Z0-9_-]+\.json)$/);
        if (!dataMatch) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }
        filePath = path.resolve(DATA_DIR, dataMatch[1]);
        if (!filePath.startsWith(DATA_DIR)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }
    } else {
        // Strictly isolate file serving to PUBLIC_DIR
        let relPath = urlWithoutQuery;
        if (relPath.startsWith('/public/')) {
            relPath = relPath.substring(7);
        } else if (relPath === '/public') {
            relPath = '/dashboard.html';
        }

        // Canonicalize and resolve strictly within PUBLIC_DIR
        filePath = path.resolve(PUBLIC_DIR, '.' + path.normalize(relPath));
        if (!filePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        // Directory index resolution (e.g. /ko/ -> /ko/index.html)
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                const indexFile = path.join(filePath, 'index.html');
                if (fs.existsSync(indexFile)) {
                    filePath = indexFile;
                }
            }
        }
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>404 Not Found</h1><p>File not found.</p>', 'utf-8');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('\n==================================================');
    console.log(`💻 Kuromoon Dashboard server is running securely on 127.0.0.1:${PORT}!`);
    console.log(`👉 Open: http://127.0.0.1:${PORT}/dashboard.html`);
    console.log('==================================================\n');
    console.log('Press Ctrl+C to stop the server.');
});

