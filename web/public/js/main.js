// Kuromoon — main.js
// Handles: Like/Bookmark, Link Copy, Kakao Share, Category Filter

// ─── Like (LocalStorage) ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const likeBtn = document.getElementById('likeBtn');
    if (!likeBtn) return;

    const placeId = document.body.getAttribute('data-place-id');
    let likes = JSON.parse(localStorage.getItem('kuromoon_likes') || '[]');
    let isLiked = likes.includes(placeId);

    updateLike();

    likeBtn.addEventListener('click', () => {
        isLiked = !isLiked;
        likes = isLiked
            ? [...likes, placeId]
            : likes.filter(id => id !== placeId);
        localStorage.setItem('kuromoon_likes', JSON.stringify(likes));
        updateLike();
    });

    function updateLike() {
        likeBtn.textContent = isLiked ? '❤️' : '🤍';
        likeBtn.classList.toggle('liked', isLiked);
    }
});

// ─── Copy Link ──────────────────────────────────────────────────────
function copyLink() {
    const url = window.location.href;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
            showToast('링크가 복사되었습니다 ✓');
        });
    } else {
        // Fallback
        const el = document.createElement('textarea');
        el.value = url;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        showToast('링크가 복사되었습니다 ✓');
    }
}

// ─── Kakao Share ────────────────────────────────────────────────────
function shareKakao() {
    // If KakaoSDK is loaded, use it; otherwise fallback to link copy
    if (window.Kakao && Kakao.isInitialized()) {
        Kakao.Share.sendDefault({
            objectType: 'feed',
            content: {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content || '',
                imageUrl: document.querySelector('meta[property="og:image"]')?.content || '',
                link: { mobileWebUrl: window.location.href, webUrl: window.location.href }
            }
        });
    } else {
        copyLink();
        showToast('카카오 SDK 미설정 — 링크가 복사되었습니다');
    }
}

// ─── Category Filter Tabs ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.tab');
    const cards = document.querySelectorAll('.place-card');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const filter = tab.getAttribute('data-category') || 'all';
            
            if (filter === 'bookmark') {
                const likes = JSON.parse(localStorage.getItem('kuromoon_likes') || '[]');
                cards.forEach(card => {
                    const placeId = card.getAttribute('data-place-id');
                    card.style.display = likes.includes(placeId) ? 'flex' : 'none';
                });
            } else {
                cards.forEach(card => {
                    const cat = card.getAttribute('data-category');
                    card.style.display = (filter === 'all' || cat === filter) ? 'flex' : 'none';
                });
            }
        });
    });

    // Search logic (Powered by Fuse.js)
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        // Prepare data for Fuse.js
        const fuseData = Array.from(cards).map(card => {
            return {
                element: card,
                title: card.querySelector('.place-card-title')?.textContent || '',
                desc: card.querySelector('.place-card-desc')?.textContent || '',
                category: card.getAttribute('data-category') || '',
                tags: card.getAttribute('data-tags') || '',
                address: card.getAttribute('data-address') || ''
            };
        });

        // Initialize Fuse
        let fuse = null;
        if (window.Fuse) {
            fuse = new Fuse(fuseData, {
                keys: ['title', 'desc', 'address'],
                threshold: 0.3, // Stricter matching (Fuzzy matching)
                ignoreLocation: true
            });
        }

        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            
            // Track search query with a 1.5s debounce to avoid flooding GA
            clearTimeout(searchTimeout);
            if (query) {
                searchTimeout = setTimeout(() => {
                    if (typeof gtag === 'function') {
                        gtag('event', 'search', {
                            'search_term': query
                        });
                    }
                }, 1500);
            }

            if (!query) {
                // Show all if empty
                cards.forEach(card => card.style.display = 'flex');
            } else if (fuse) {
                // Use Fuse.js fuzzy search
                const results = fuse.search(query);
                
                // Hide all first
                cards.forEach(card => card.style.display = 'none');
                
                // Show only matched elements
                results.forEach(result => {
                    result.item.element.style.display = 'flex';
                });
            } else {
                // Fallback simple search
                const q = query.toLowerCase();
                cards.forEach(card => {
                    const title = card.querySelector('.place-card-title')?.textContent.toLowerCase() || '';
                    const desc = card.querySelector('.place-card-desc')?.textContent.toLowerCase() || '';
                    const address = card.getAttribute('data-address')?.toLowerCase() || '';
                    card.style.display = (title.includes(q) || desc.includes(q) || address.includes(q)) ? 'flex' : 'none';
                });
            }
            
            // Reset tabs to "All"
            tabs.forEach(t => t.classList.remove('active'));
            if(tabs[0]) tabs[0].classList.add('active');
        });
    }
});

// ─── Toast Notification ─────────────────────────────────────────────
function showToast(msg) {
    const existing = document.querySelector('.km-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'km-toast';
    toast.textContent = msg;
    toast.style.cssText = `
        position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
        background: #0d0f14; color: white; padding: 0.65rem 1.25rem;
        border-radius: 20px; font-size: 0.85rem; font-weight: 500;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 9999;
        animation: toastIn 0.2s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

// Inject toast animation
const style = document.createElement('style');
style.textContent = '@keyframes toastIn { from { opacity:0; transform:translateX(-50%) translateY(10px) } to { opacity:1; transform:translateX(-50%) translateY(0) } }';
document.head.appendChild(style);
