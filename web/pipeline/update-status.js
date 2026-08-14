/**
 * Kuromoon Pipeline — Status Update Runner
 * 
 * Runs a fast subset of the pipeline to re-verify, update operating statuses (KST dates),
 * and rebuild the static site for existing places.
 * Skips trend detection and place collection.
 * 
 * Usage: node pipeline/update-status.js
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

// ─── Load .env file ───
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
            case 'crawler': {
                const filePath = path.join(dataDir, 'places.json');
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
                    const totalPages = data.length * 2 + 2;
                    return `정적 웹페이지 ${totalPages}개 빌드 완료 (한글/영문 상세 및 인덱스)`;
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
            stdio: 'inherit',
            env: process.env
        });
        log(`✅ ${name} — completed`);
        
        const summary = getStepSummary(stepId);
        appendLog(stepId, 'success', summary);
        return true;
    } catch (err) {
        log(`❌ ${name} — failed (exit code: ${err.status})`);
        appendLog(stepId, 'error', `${name} 실패 (exit code: ${err.status})`);
        return false;
    }
}

async function main() {
    const startTime = Date.now();

    log('╔══════════════════════════════════════════════╗');
    log('║   Kuromoon Pipeline — Status Update Run      ║');
    log('╚══════════════════════════════════════════════╝');

    appendLog('status-update-start', 'success', '운영 상태 동기화 및 자가 검증 시작');

    // Run Crawler & Status Checker (checks dates and blogs for status changes)
    if (!runStep('Crawler & Status Checker (Naver+Gemini)', path.join(PIPELINE_DIR, 'crawler.js'), 'crawler')) process.exit(1);

    // Run Self-Verification
    if (!runStep('Self-Verification (3 Filters)', path.join(PIPELINE_DIR, 'verify.js'), 'verify')) process.exit(1);

    // Run Metadata Enrichment
    if (!runStep('Naver Place Metadata Enrichment', path.join(PIPELINE_DIR, 'enrich-places.js'), 'enrich-places')) process.exit(1);

    // Rebuild Pages
    if (!runStep('Static Site Build', path.join(PIPELINE_DIR, '..', 'build.js'), 'build')) process.exit(1);

    // Generate SEO
    if (!runStep('SEO Assets Generation', path.join(PIPELINE_DIR, 'generate-seo.js'), 'seo')) process.exit(1);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Generate final complete summary
    let finalSummary = `운영 상태 동기화 완료 (${elapsed}초 소요)`;
    try {
        const dataDir = path.join(WEB_DIR, 'data');
        const pPath = path.join(dataDir, 'places.json');
        const pLen = fs.existsSync(pPath) ? JSON.parse(fs.readFileSync(pPath, 'utf8')).length : 0;
        const pagesBuilt = pLen * 2 + 2;

        finalSummary = `상태 동기화 완료: 총 ${pLen}개 장소 검증 및 업데이트 (${pagesBuilt}개 페이지 빌드, ${elapsed}초 소요)`;
    } catch (e) {}

    appendLog('pipeline-complete', 'success', finalSummary);

    log(`\n╔══════════════════════════════════════════════╗`);
    log(`║   Status Update Complete! (${elapsed}s)            ║`);
    log(`╚══════════════════════════════════════════════╝\n`);
}

main();
