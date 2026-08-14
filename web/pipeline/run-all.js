/**
 * Kuromoon Pipeline — Master Runner
 * 
 * Orchestrates the entire pipeline in sequence:
 *   1. Trend Detection (Naver DataLab)
 *   2. Data Collection & AI Refinement (Gemini)
 *   3. Self-Verification (3 Filters)
 *   4. Static Site Build (HTML generation)
 *   5. SEO Assets Generation (sitemap, robots, llms.txt)
 * 
 * Usage: node pipeline/run-all.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PIPELINE_DIR = __dirname;
const WEB_DIR = path.resolve(PIPELINE_DIR, '..');
const LOG_FILE = path.join(WEB_DIR, 'data', 'pipeline_log.json');

let initialPlacesCount = 0;
try {
    const pPath = path.join(WEB_DIR, 'data', 'places.json');
    if (fs.existsSync(pPath)) {
        initialPlacesCount = JSON.parse(fs.readFileSync(pPath, 'utf8')).length;
    }
} catch(e) {}

// ─── Load .env file (lightweight, no npm dependency) ───
const envPath = path.join(WEB_DIR, '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                const key = trimmed.substring(0, eqIdx).trim();
                const val = trimmed.substring(eqIdx + 1).trim();
                if (val && !process.env[key]) {
                    process.env[key] = val;
                }
            }
        }
    });
    console.log(`[.env] Loaded API keys from ${envPath}`);
} else {
    console.log('[.env] No .env file found — using system environment variables');
}

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function appendLog(step, status, summary) {
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
        try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) { logs = []; }
    }
    logs.push({
        timestamp: new Date().toISOString(),
        step,
        status,
        summary
    });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
}

function getStepSummary(stepId) {
    try {
        const dataDir = path.join(WEB_DIR, 'data');
        switch (stepId) {
            case 'trend-detect': {
                const filePath = path.join(dataDir, 'trending_keywords.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const totalKeywords = Object.values(data.categories || {}).reduce((sum, cat) => sum + (cat.trending_keywords?.length || 0), 0);
                    return `트렌드 키워드 ${totalKeywords}개 감지 완료`;
                }
                return 'Trend Detection 완료';
            }
            case 'collect-places': {
                const filePath = path.join(dataDir, 'raw_inputs.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return `지도 및 리뷰 수집 완료 (후보 장소 ${data.length}개 수집)`;
                }
                return 'Automatic Place Collection 완료';
            }
            case 'refine': {
                const filePath = path.join(dataDir, 'refined_places.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return `AI 정보 정제 완료 (장소 ${data.length}개 정밀화)`;
                }
                return 'AI Data Refinement 완료';
            }
            case 'crawler': {
                const filePath = path.join(dataDir, 'refined_places.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return `실시간 운영 상태 분석 완료 (장소 ${data.length}개 상태 검증)`;
                }
                return 'Crawler & Status Checker 완료';
            }
            case 'verify': {
                const pPath = path.join(dataDir, 'places.json');
                const rPath = path.join(dataDir, 'review_needed.json');
                const dPath = path.join(dataDir, 'discarded_places.json');
                const pLen = fs.existsSync(pPath) ? JSON.parse(fs.readFileSync(pPath, 'utf8')).length : 0;
                const rLen = fs.existsSync(rPath) ? JSON.parse(fs.readFileSync(rPath, 'utf8')).length : 0;
                const dLen = fs.existsSync(dPath) ? JSON.parse(fs.readFileSync(dPath, 'utf8')).length : 0;
                const newAdded = Math.max(pLen - initialPlacesCount, 0);
                return `자가 검증 완료 (누적 발행: ${pLen}개, 이번 실행에서 신규 추가: +${newAdded}개, 검토필요: ${rLen}개, 폐기: ${dLen}개)`;
            }
            case 'enrich-places': {
                const filePath = path.join(dataDir, 'places.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const enrichedCount = data.filter(p => p.metadata_enriched).length;
                    return `네이버 플레이스 메타데이터 보강 완료 (누적 ${enrichedCount}/${data.length}개 완료)`;
                }
                return 'Naver Place Metadata Enrichment 완료';
            }
            case 'build': {
                const filePath = path.join(dataDir, 'places.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const pagesBuilt = data.length * 2 + 2;
                    return `정적 웹페이지 ${pagesBuilt}개 빌드 완료 (한글/영문 상세 및 인덱스)`;
                }
                return 'Static Site Build 완료';
            }
            case 'seo': {
                const filePath = path.join(dataDir, 'places.json');
                if (fs.existsSync(filePath)) {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const urlsCount = data.length * 2 + 2;
                    return `SEO 자산 생성 완료 (sitemap.xml에 ${urlsCount}개 URL 등록)`;
                }
                return 'SEO Assets Generation 완료';
            }
            default:
                return '완료';
        }
    } catch (e) {
        return '완료 (데이터 집계 오류)';
    }
}

function runStep(name, script, stepId) {
    log(`\n${'═'.repeat(50)}`);
    log(`▶ STEP: ${name}`);
    log('═'.repeat(50));

    try {
        execSync(`node "${script}"`, {
            cwd: path.resolve(PIPELINE_DIR, '..'),
            stdio: ['inherit', 'inherit', 'pipe'],
            env: process.env
        });
        log(`✅ ${name} — completed`);
        
        if (stepId !== 'trend-detect') {
            const summary = getStepSummary(stepId);
            appendLog(stepId, 'success', summary);
        }
        return true;
    } catch (err) {
        const stderrStr = err.stderr ? err.stderr.toString('utf8').trim() : '';
        if (stderrStr) {
            console.error(stderrStr);
        }
        log(`❌ ${name} — failed (exit code: ${err.status})`);
        appendLog(stepId, 'error', `${name} 실패 (exit code: ${err.status})${stderrStr ? ` - Error: ${stderrStr}` : ''}`);
        return false;
    }
}

async function main() {
    const startTime = Date.now();

    log('╔══════════════════════════════════════════════╗');
    log('║   Kuromoon Pipeline — Full Automation Run     ║');
    log('╚══════════════════════════════════════════════╝');

    appendLog('pipeline-start', 'success', '전체 파이프라인 실행 시작');

    // Step 1: Trend Detection
    runStep('Trend Detection', path.join(PIPELINE_DIR, 'trend-detect.js'), 'trend-detect');

    // Step 1.5: Automatic Place Collection
    runStep('Automatic Place Collection', path.join(PIPELINE_DIR, 'collect-places.js'), 'collect-places');

    // Step 2: Crawler & Status Checker
    runStep('Crawler & Status Checker (Naver+Gemini)', path.join(PIPELINE_DIR, 'crawler.js'), 'crawler');

    // Step 3: Self-Verification
    runStep('Self-Verification (3 Filters)', path.join(PIPELINE_DIR, 'verify.js'), 'verify');

    // Step 4: AI Data Refinement
    runStep('AI Data Refinement (Gemini)', path.join(PIPELINE_DIR, 'refine.js'), 'refine');

    // Step 4.5: Naver Place Metadata Enrichment
    runStep('Naver Place Metadata Enrichment', path.join(PIPELINE_DIR, 'enrich-places.js'), 'enrich-places');

    // Step 5: Static Site Build
    runStep('Static Site Build', path.join(PIPELINE_DIR, '..', 'build.js'), 'build');

    // Step 6: SEO Assets
    runStep('SEO Assets Generation', path.join(PIPELINE_DIR, 'generate-seo.js'), 'seo');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Generate pipeline-complete rich summary
    let finalSummary = `전체 파이프라인 완료 (${elapsed}초 소요)`;
    try {
        const dataDir = path.join(WEB_DIR, 'data');
        const kwPath = path.join(dataDir, 'trending_keywords.json');
        const rawPath = path.join(dataDir, 'raw_inputs.json');
        const pPath = path.join(dataDir, 'places.json');

        const kwLen = fs.existsSync(kwPath) ? Object.values(JSON.parse(fs.readFileSync(kwPath, 'utf8')).categories || {}).reduce((sum, cat) => sum + (cat.trending_keywords?.length || 0), 0) : 0;
        const rawLen = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')).length : 0;
        const pLen = fs.existsSync(pPath) ? JSON.parse(fs.readFileSync(pPath, 'utf8')).length : 0;
        const pagesBuilt = pLen * 2 + 2;
        const newAdded = Math.max(pLen - initialPlacesCount, 0);

        finalSummary = `전체 완료: 키워드 ${kwLen}개 포착 ➔ 후보 ${rawLen}개 추출 ➔ 누적 ${pLen}개 발행 (신규 +${newAdded}개, ${pagesBuilt}개 페이지 빌드, ${elapsed}초 소요)`;
    } catch (e) {
        // ignore
    }

    appendLog('pipeline-complete', 'success', finalSummary);

    // Step 7: Auto Git Commit & Push (if --push or --auto-push flag is provided)
    const shouldPush = process.argv.includes('--push') || process.argv.includes('--auto-push') || process.env.AUTO_PUSH === 'true';
    if (shouldPush) {
        log(`\n${'═'.repeat(50)}`);
        log('▶ STEP: Git Commit & Push (Auto Deploy)');
        log('═'.repeat(50));
        try {
            const rootDir = path.resolve(WEB_DIR, '..');
            execSync('git add -A', { cwd: rootDir, stdio: 'inherit' });
            try {
                const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                execSync(`git commit -m "🤖 Local Auto-update: ${dateStr}"`, { cwd: rootDir, stdio: 'inherit' });
                execSync('git push', { cwd: rootDir, stdio: 'inherit' });
                log('✅ Git push completed successfully! (Cloudflare Pages will auto-deploy)');
                appendLog('git-push', 'success', 'Git Commit & Push 완료');
            } catch (e) {
                log('ℹ️ Git commit skipped (no changes to commit)');
            }
        } catch (e) {
            log(`❌ Git Push failed: ${e.message}`);
            appendLog('git-push', 'error', `Git Push 실패: ${e.message}`);
        }
    }

    log(`\n╔══════════════════════════════════════════════╗`);
    log(`║   Pipeline Complete! (${elapsed}s)                  ║`);
    log(`╚══════════════════════════════════════════════╝\n`);
}

main();

