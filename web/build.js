/**
 * Kuromoon — Static Site Generator (build.js)
 *
 * Reads data/places.json, injects into HTML templates,
 * outputs fully SEO-optimized static pages in /public/ko/ and /public/en/
 *
 * Usage: node build.js  (or: npm run build)
 */

const fs = require('fs');
const path = require('path');

// Load .env if exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^#\s][^=]+)=(.*)$/);
        if (match) {
            process.env[match[1].trim()] = match[2].trim();
        }
    });
}

const WEB_DIR    = __dirname;
const DATA_DIR   = path.join(WEB_DIR, 'data');
const TMPL_DIR   = path.join(WEB_DIR, 'templates');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');

const SITE_URL = 'https://kuromoon.com';

// ─── Category display labels ────────────────────────────────────────
const CATEGORY_LABELS = {
  ko: { popup: '팝업/전시', activity: '이색 체험', beauty: '뷰티/웰니스', dining: '컨셉 다이닝', cafe: '아트/테마 카페', festival: '지역축제', exhibition: '전시회', fair: '페어/박람회' },
  en: { popup: 'Pop-up/Exhibition', activity: 'Activity/DIY', beauty: 'Wellness/Beauty', dining: 'Concept Dining', cafe: 'Art/Theme Cafe', festival: 'Festival', exhibition: 'Exhibition', fair: 'Fair' }
};

// ─── i18n strings ───────────────────────────────────────────────────
const I18N = {
  ko: {
    metaTitle:   '쿠로문 — AI가 추천하는 한국 로컬의 진짜 평판',
    metaDesc:    'AI 검색 엔진이 인용하는 한국 맛집·팝업스토어·K뷰티 정보. 성수동, 홍대, 강남, 이태원 등 서울 주요 지역.',
    ogLocale:    'ko_KR',
    heroBadge:   'AI 인용 출처 1위 한국 로컬 디렉토리',
    heroTitle:   '오늘 새로운 경험',
    heroSub:     '',
    tabAll:      '전체', tabPopup: '팝업', tabActivity: '체험', tabBeauty: '웰니스',
    tabDining:   '다이닝', tabCafe:  '카페',
    labelAddr:   '주소', labelHours: '운영시간', labelPrice: '가격대',
    labelParking: '주차', labelForeign: '외국어 응대',
    bookingBtn:  '예약하기',
  },
  en: {
    metaTitle:   'Kuromoon — True Local Reputation in Korea, Curated by AI',
    metaDesc:    'AI-cited Korean local guide: pop-up stores, K-beauty clinics, niche dining, concept cafes in Seoul.',
    ogLocale:    'en_US',
    heroBadge:   '#1 AI-cited Korea Local Directory',
    heroTitle:   'A New Experience Today',
    heroSub:     '',
    tabAll:      'All', tabPopup: 'Pop-up', tabActivity: 'Activity', tabBeauty: 'Wellness',
    tabDining:   'Dining', tabCafe:  'Cafe',
    labelAddr:   'Address', labelHours: 'Hours', labelPrice: 'Price',
    labelParking: 'Parking', labelForeign: 'Foreigner Friendly',
    bookingBtn:  'Book Now',
  }
};

// ─── Helpers ────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Generate JSON-LD for Schema.org ─────────────────────────────────
function buildSchemaLD(place, lang) {
  const isKo = lang === 'ko';
  const name = isKo ? place.name_ko : place.name_en;
  const address = isKo ? place.address_ko : place.address_en;
  const summary = isKo ? place.summary_ko : place.summary_en;

  const typeMap = {
    popup: 'Event',
    beauty: 'BeautySalon',
    dining: 'Restaurant',
    cafe: 'CafeOrCoffeeShop',
    festival: 'Festival',
    exhibition: 'ExhibitionEvent',
    fair: 'BusinessEvent'
  };
  const schemaType = typeMap[place.category] || 'LocalBusiness';

  const schema = {
    "@context": "https://schema.org",
    "@type": schemaType,
    "name": name,
    "description": summary,
    "image": place.image || `${SITE_URL}/img/og-default.jpg`,
    "address": {
      "@type": "PostalAddress",
      "streetAddress": address,
      "addressCountry": "KR"
    }
  };

  if (place.reservation_url) {
    schema.potentialAction = {
      "@type": "ReserveAction",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": place.reservation_url
      }
    };
  }

  if (schemaType.includes('Event')) {
    schema.startDate = place.startDate || new Date().toISOString().split('T')[0];
    if (place.endDate) schema.endDate = place.endDate;
    schema.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";
    schema.eventStatus = "https://schema.org/EventScheduled";
    schema.location = {
      "@type": "Place",
      "name": name,
      "address": schema.address
    };
  }

  return JSON.stringify(schema, null, 2);
}

// ─── Build Index Page ────────────────────────────────────────────────
function buildIndexPage(lang, places, template) {
  const t    = I18N[lang];
  const isKo = lang === 'ko';

  const sortedPlaces = [...places].sort((a, b) => {
    const dateA = a.created_at || '1970-01-01';
    const dateB = b.created_at || '1970-01-01';
    if (dateA === dateB) {
      return (b.confidence_score || 0) - (a.confidence_score || 0);
    }
    return dateB.localeCompare(dateA);
  });

  let listHtml = '';
  sortedPlaces.forEach(place => {
    const name    = isKo ? place.name_ko    : place.name_en;
    const summary = isKo ? place.summary_ko : place.summary_en;
    const catLabel = CATEGORY_LABELS[lang][place.category] || place.category;

    const imgHtml = '';
    listHtml += `
      <a href="./places/${place.id}.html" class="place-card" data-category="${place.category}" data-place-id="${place.id}">
        ${imgHtml}
        <div class="place-card-body">
          <div class="place-card-category">${catLabel}</div>
          <h2 class="place-card-title">${name}</h2>
          <p class="place-card-desc">${summary}</p>
        </div>
      </a>
    `;
  });

  const html = template
    .replace(/\{\{GA_MEASUREMENT_ID\}\}/g, process.env.GA_MEASUREMENT_ID || 'G-XXXXXXXXXX')
    .replace(/\{\{LANG\}\}/g,         lang)
    .replace(/\{\{META_TITLE\}\}/g,   t.metaTitle)
    .replace(/\{\{META_DESCRIPTION\}\}/g, t.metaDesc)
    .replace(/\{\{OG_LOCALE\}\}/g,    t.ogLocale)
    .replace(/\{\{HERO_BADGE\}\}/g,   t.heroBadge)
    .replace(/\{\{HERO_TITLE\}\}/g,   t.heroTitle)
    .replace(/\{\{HERO_SUB\}\}/g,     t.heroSub)
    .replace(/\{\{KO_ACTIVE\}\}/g,    isKo ? 'active' : '')
    .replace(/\{\{EN_ACTIVE\}\}/g,    !isKo ? 'active' : '')
    .replace(/\{\{TAB_ALL\}\}/g,      t.tabAll)
    .replace(/\{\{TAB_POPUP\}\}/g,    t.tabPopup)
    .replace(/\{\{TAB_ACTIVITY\}\}/g, t.tabActivity)
    .replace(/\{\{TAB_BEAUTY\}\}/g,   t.tabBeauty)
    .replace(/\{\{TAB_DINING\}\}/g,   t.tabDining)
    .replace(/\{\{TAB_CAFE\}\}/g,     t.tabCafe)
    .replace(/\{\{TAB_BOOKMARK\}\}/g, isKo ? '저장됨' : 'Saved')
    .replace(/\{\{PLACES_LIST\}\}/g,  listHtml);

  fs.writeFileSync(path.join(PUBLIC_DIR, lang, 'index.html'), html, 'utf8');
}

// ─── Build Detail Pages ──────────────────────────────────────────────
function buildDetailPages(lang, places, template) {
  const t    = I18N[lang];
  const isKo = lang === 'ko';

  places.forEach(place => {
    const name    = isKo ? place.name_ko    : place.name_en;
    const address = isKo ? place.address_ko : place.address_en;
    const summary = isKo ? place.summary_ko : place.summary_en;
    const catLabel = CATEGORY_LABELS[lang][place.category] || place.category;

    // Tags
    const tagsHtml = (place.tags || []).map(tag => `<span class="tag">#${tag}</span>`).join('');

    // Event Dates UI
    const eventDatesHtml = (place.startDate && place.endDate)
      ? `<div class="event-dates">🗓️ ${isKo ? '진행 기간' : 'Period'}: ${place.startDate} ~ ${place.endDate}</div>`
      : '';

    // Info rows
    let infoRows = '';
    if (address) infoRows += `<div class="info-row"><span class="info-icon">📍</span><span class="info-label">${t.labelAddr}</span><span class="info-value">${address}</span></div>`;
    if (place.hours) infoRows += `<div class="info-row"><span class="info-icon">🕒</span><span class="info-label">${t.labelHours}</span><span class="info-value">${place.hours}</span></div>`;
    if (place.price_range) infoRows += `<div class="info-row"><span class="info-icon">💰</span><span class="info-label">${t.labelPrice}</span><span class="info-value">${place.price_range}</span></div>`;

    // Parking Row
    if (place.parking === true) {
      const parkingVal = isKo ? '가능 (Available)' : 'Available';
      infoRows += `<div class="info-row"><span class="info-icon">🚗</span><span class="info-label">${t.labelParking}</span><span class="info-value">${parkingVal}</span></div>`;
    }
    // Foreign Friendly Row
    if (place.foreign_friendly === true) {
      const foreignVal = isKo ? '지원 (Yes)' : 'Yes';
      infoRows += `<div class="info-row"><span class="info-icon">🌐</span><span class="info-label">${t.labelForeign}</span><span class="info-value">${foreignVal}</span></div>`;
    }

    // Map Links (Deep Links for UX)
    let mapButtons = '';
    if (address) {
      // 층수/호수 등 검색 방해 요소 제거 (예: 1층, 2F, 105호, 지하1층 등)
      const cleanAddress = address.replace(/\s+(\d+층|\d+호|\d+F|지하\s*\d+층|지상\s*\d+층).*$/i, '').trim();
      
      // Use place name for Naver/Kakao maps (requested for popups as well to avoid general location info overflow)
      const naverKakaoQueryStr = place.name_ko;
      const naverKakaoQuery = encodeURIComponent(naverKakaoQueryStr);
      
      // Use localized query for Google maps (which can be English or Korean)
      const googleQueryStr = name;
      const googleQuery = encodeURIComponent(googleQueryStr);
      
      if (isKo) {
        mapButtons += `<a href="https://map.naver.com/v5/search/${naverKakaoQuery}" target="_blank" rel="noopener" class="btn btn-secondary" style="border-color:#03c75a; color:#03c75a;">🟢 네이버 지도</a>`;
        mapButtons += `<a href="https://map.kakao.com/link/search/${naverKakaoQuery}" target="_blank" rel="noopener" class="btn btn-secondary" style="border-color:#FEE500; color:#391B1B;">🟡 카카오맵</a>`;
      } else {
        mapButtons += `<a href="https://www.google.com/maps/search/?api=1&query=${googleQuery}" target="_blank" rel="noopener" class="btn btn-secondary" style="border-color:#4285F4; color:#4285F4;">🔵 Google Maps</a>`;
        mapButtons += `<a href="https://map.naver.com/v5/search/${naverKakaoQuery}" target="_blank" rel="noopener" class="btn btn-secondary" style="border-color:#03c75a; color:#03c75a;">🟢 Naver Map</a>`;
      }
    }

    // Reservation Button Block
    let reservationBtnBlock = '';
    if (place.reservation_url) {
      const bookingText = isKo ? '지금 예약하기' : 'Book Now';
      reservationBtnBlock = `
        <div class="action-buttons" style="margin-bottom:0.75rem;">
          <a href="${place.reservation_url}" target="_blank" rel="noopener" class="btn btn-primary" style="display:block; width:100%;">📅 ${bookingText}</a>
        </div>
      `;
    }

    // Instagram Button Block
    let instagramBtnBlock = '';
    if (place.instagram) {
      let instaUrl = place.instagram.trim();
      if (instaUrl.includes('instagram.com/')) {
        const parts = instaUrl.split('instagram.com/');
        const username = parts[1].split('?')[0].replace(/\/$/, '');
        instaUrl = `https://www.instagram.com/${username}/`;
      }
      instagramBtnBlock = `
        <a href="${instaUrl}" target="_blank" rel="noopener" class="btn btn-secondary" style="border-color:#e1306c; color:#e1306c;">📸 Instagram</a>
      `;
    }


    // Trust / Status Badge Block
    let statusBadgeBlock = '';
    const reviewCount = place.review_count || 0;
    const statusText = place.operating_status || '확인 불가';
    
    // Hide operating status if it is "확인 불가" or "Verification Unknown"
    const showStatus = statusText !== '확인 불가' && statusText !== 'Verification Unknown';
    
    if (isKo) {
      statusBadgeBlock = `
        <div class="source-badge">
          🔥 네이버 블로그 리뷰 ${reviewCount}건 돌파
          ${showStatus ? `<br/>✅ 최근 상태: ${statusText}` : ''}
        </div>
      `;
    } else {
      statusBadgeBlock = `
        <div class="source-badge">
          🔥 Over ${reviewCount} Naver blog reviews
          ${showStatus ? `<br/>✅ Recent status: ${statusText}` : ''}
        </div>
      `;
    }

    // Schema.org
    const jsonLd = buildSchemaLD(place, lang);

    // Hero Image Block completely removed per user request
    const heroImageBlock = '';

    const keywords = (place.tags || []).join(',');

    const html = template
      .replace(/\{\{GA_MEASUREMENT_ID\}\}/g,   process.env.GA_MEASUREMENT_ID || 'G-XXXXXXXXXX')
      .replace(/\{\{PLACE_KEYWORDS\}\}/g,      keywords.replace(/'/g, "\\'"))
      .replace(/\{\{PLACE_CATEGORY_RAW\}\}/g,  place.category || '')
      .replace(/\{\{LANG\}\}/g,               lang)
      .replace(/\{\{PLACE_ID\}\}/g,           place.id)
      .replace(/\{\{PLACE_NAME\}\}/g,         name)
      .replace(/\{\{PLACE_IMAGE\}\}/g,        place.image || '')
      .replace(/\{\{HERO_IMAGE_BLOCK\}\}/g,   heroImageBlock)
      .replace(/\{\{PLACE_SUMMARY\}\}/g,      summary || '')
      .replace(/\{\{PLACE_DESCRIPTION\}\}/g,  (isKo ? place.description_ko : place.description_en) || '')
      .replace(/\{\{PLACE_CATEGORY_LABEL\}\}/g, catLabel)
      .replace(/\{\{STATUS_BADGE_BLOCK\}\}/g,  statusBadgeBlock)
      .replace(/\{\{EVENT_DATES\}\}/g,        eventDatesHtml)
      .replace(/\{\{TAGS\}\}/g,               tagsHtml)
      .replace(/\{\{INFO_ROWS\}\}/g,          infoRows)
      .replace(/\{\{MAP_BUTTONS\}\}/g,        mapButtons)
      .replace(/\{\{RESERVATION_BTN_BLOCK\}\}/g, reservationBtnBlock)
      .replace(/\{\{INSTAGRAM_BTN_BLOCK\}\}/g,   instagramBtnBlock)

      .replace(/\{\{JSON_LD\}\}/g,            jsonLd)
      .replace(/\{\{OG_LOCALE\}\}/g,          t.ogLocale)
      .replace(/\{\{KO_ACTIVE\}\}/g,          isKo ? 'active' : '')
      .replace(/\{\{EN_ACTIVE\}\}/g,          !isKo ? 'active' : '')
      .replace(/\{\{KAKAO_JS_KEY\}\}/g,       process.env.KAKAO_JS_KEY || '');

    fs.writeFileSync(path.join(PUBLIC_DIR, lang, 'places', `${place.id}.html`), html, 'utf8');
  });
}

function buildRootRedirectPage() {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0; url=./ko/index.html">
  <title>Kuromoon — Korea Trending Places & Pop-up Guide</title>
  <script>
    (function() {
      var lang = navigator.language || navigator.userLanguage || '';
      if (lang.toLowerCase().startsWith('en')) {
        window.location.replace('./en/index.html');
      } else {
        window.location.replace('./ko/index.html');
      }
    })();
  </script>
</head>
<body>
  <p>Redirecting to <a href="./ko/index.html">Kuromoon Main Page</a>...</p>
</body>
</html>`;
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
}

// ─── Main ────────────────────────────────────────────────────────────
function main() {
  log('🔨 Building Kuromoon Static Site...');

  // Ensure output directories
  ['ko', 'en', 'ko/places', 'en/places'].forEach(d => ensureDir(path.join(PUBLIC_DIR, d)));

  // Load data
  const placesFile = path.join(DATA_DIR, 'places.json');
  if (!fs.existsSync(placesFile)) {
    log('❌ data/places.json not found');
    process.exit(1);
  }
  const places = JSON.parse(fs.readFileSync(placesFile, 'utf8'));
  log(`📄 Loaded ${places.length} places`);

  // Load templates
  const indexTmpl  = fs.readFileSync(path.join(TMPL_DIR, 'index.html'), 'utf8');
  const detailTmpl = fs.readFileSync(path.join(TMPL_DIR, 'place-detail.html'), 'utf8');

  // Build all pages
  ['ko', 'en'].forEach(lang => {
    buildIndexPage(lang, places, indexTmpl);
    buildDetailPages(lang, places, detailTmpl);
    log(`✅ Built ${lang.toUpperCase()}: 1 index + ${places.length} detail pages`);
  });

  // Build root language redirect page
  buildRootRedirectPage();
  log(`✅ Built root language redirect page: web/public/index.html`);

  log(`\n✅ Build Complete! ${places.length * 2 + 2} total pages generated.`);

  // Automatic Pagefind Indexing
  try {
    const { execSync } = require('child_process');
    log('\n🔍 Generating Pagefind Search Index...');
    execSync('npx pagefind --site public', { cwd: WEB_DIR, stdio: 'inherit' });
    log('✅ Pagefind Search Index generated successfully!');
  } catch (e) {
    log(`⚠️ Pagefind indexing warning: ${e.message}`);
  }
}

main();
