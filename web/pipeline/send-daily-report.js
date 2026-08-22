const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const match = line.match(/^([^#\s][^=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    });
}

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const TARGET_EMAIL = 'directresearchkorea@gmail.com';

const logPath = path.join(__dirname, '..', 'data', 'pipeline_log.json');

async function sendReport() {
    console.log('Generating daily pipeline report...');
    
    if (!EMAIL_USER || !EMAIL_PASS) {
        console.error('Email credentials not found in .env');
        process.exit(1);
    }

    let logs = [];
    if (fs.existsSync(logPath)) {
        try {
            logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (e) {
            console.error('Error parsing pipeline_log.json:', e);
        }
    }

    // Get logs from the last 24 hours
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    const recentLogs = logs.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        return (now - logTime) <= oneDayMs;
    });

    const errors = recentLogs.filter(l => l.status === 'error');
    const completes = recentLogs.filter(l => l.step === 'pipeline-complete');
    const runs = recentLogs.filter(l => l.step === 'pipeline-start');

    // Build Summary Text
    let summaryText = '';
    
    // 1. 파이프라인 정상 구동 여부
    if (runs.length > 0) {
        summaryText += `✅ 파이프라인이 정상 시간에 구동되었습니다. (최근 24시간 내 ${runs.length}회 실행)\n`;
    } else {
        summaryText += `⚠️ 최근 24시간 내에 파이프라인 실행(시작) 기록이 없습니다.\n`;
    }

    // 2. 빌드된 장소 및 요약
    if (completes.length > 0) {
        const lastComplete = completes[completes.length - 1];
        // 텍스트 인코딩 깨짐을 방지하기 위한 안전한 요약 가져오기
        summaryText += `\n[최근 완료 요약]\n${lastComplete.summary}\n`;
        summaryText += `(완료 시각: ${new Date(lastComplete.timestamp).toLocaleString('ko-KR')})\n`;
    } else {
        summaryText += `\n⚠️ 최근 24시간 내에 파이프라인 전체 완료(pipeline-complete) 로그가 없습니다.\n`;
    }

    // 3. 오류 발생 여부
    summaryText += `\n[오류 내역]\n`;
    if (errors.length > 0) {
        summaryText += `❌ 발생한 오류 수: ${errors.length}건\n`;
        errors.forEach(e => {
            summaryText += `- [${e.step}] ${e.summary} (${new Date(e.timestamp).toLocaleString('ko-KR')})\n`;
        });
    } else {
        summaryText += `✨ 오류 없이 성공적으로 완료되었습니다.\n`;
    }

    // Send email
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });

    // Formatting date for subject
    const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = kstDate.toISOString().split('T')[0];

    const mailOptions = {
        from: `"Kuromoon Pipeline" <${EMAIL_USER}>`,
        to: TARGET_EMAIL,
        subject: `[Kuromoon] 파이프라인 일일 작업 요약 리포트 (${dateStr})`,
        text: `안녕하세요,\n\nKuromoon 파이프라인의 오늘 하루 작업 결과를 요약해 드립니다.\n\n${summaryText}\n\n감사합니다.\nKuromoon 자동화 시스템 올림`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Daily report email sent successfully to ${TARGET_EMAIL}!`);
    } catch (err) {
        console.error('❌ Failed to send email:', err);
    }
}

sendReport();
