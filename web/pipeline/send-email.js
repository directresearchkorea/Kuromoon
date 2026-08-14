/**
 * Kuromoon Pipeline — Email Reporter
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const WEB_DIR = path.resolve(__dirname, '..');
const envPath = path.join(WEB_DIR, '.env');

// Load .env
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
}

async function sendReport() {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    const toEmail = process.env.EMAIL_TO || 'yourfriendjay@gmail.com';

    if (!emailUser || !emailPass) {
        console.error('❌ EMAIL_USER or EMAIL_PASS not found in .env. Skipping email report.');
        return;
    }

    // Read places data
    const placesPath = path.join(WEB_DIR, 'data', 'places.json');
    let totalPlaces = 0;
    let places = [];
    if (fs.existsSync(placesPath)) {
        places = JSON.parse(fs.readFileSync(placesPath, 'utf8'));
        totalPlaces = places.length;
    }

    const today = new Date().toISOString().split('T')[0];
    
    let htmlContent = `<h2>🌙 Kuromoon 일일 파이프라인 리포트</h2>`;
    htmlContent += `<p>보고 일자: <strong>${today}</strong></p>`;
    htmlContent += `<p>현재 웹사이트에 등록된 총 장소 수: <strong>${totalPlaces}개</strong></p>`;
    htmlContent += `<h3>[오늘의 트렌드 장소 목록]</h3><ul>`;
    
    places.forEach(p => {
        htmlContent += `<li><strong>${p.name_ko}</strong> (${p.category}) - 신뢰도 점수: ${p.confidence_score}</li>`;
    });
    htmlContent += `</ul><p>파이프라인 실행 및 정적 사이트 빌드가 무사히 완료되었습니다.</p>`;

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });

    try {
        const info = await transporter.sendMail({
            from: `"Kuromoon Pipeline" <${emailUser}>`,
            to: toEmail,
            subject: `[Kuromoon] 자동화 파이프라인 일일 보고서 (${today})`,
            html: htmlContent
        });
        console.log('✅ Email report sent successfully:', info.messageId);
    } catch (err) {
        console.error('❌ Error sending email:', err);
    }
}

sendReport();
