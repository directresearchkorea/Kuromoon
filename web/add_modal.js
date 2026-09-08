const fs = require('fs'); let html = fs.readFileSync('public/dashboard.html', 'utf8'); const modalCode = \
  <!-- Edit Modal -->
  <div id=\"editModal\" class=\"modal\" style=\"display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.5);\">
    <div class=\"modal-content\" style=\"background-color: var(--surface-light); margin: 5% auto; padding: 20px; border: 1px solid var(--border); width: 80%; max-width: 800px; border-radius: 8px; color: var(--text-primary);\">
      <span onclick=\"closeEditModal()\" style=\"color: var(--text-muted); float: right; font-size: 28px; font-weight: bold; cursor: pointer;\">&times;</span>
      <h2 id=\"editModalTitle\">장소 상세 검수 및 편집</h2>
      <div id=\"editModalScoreInfo\" style=\"background: rgba(255,255,255,0.05); padding: 10px; border-radius: 4px; margin-bottom: 15px; font-size: 0.9rem; color: var(--accent);\"></div>
      
      <form id=\"editPlaceForm\" onsubmit=\"submitEdit(event)\">
        <input type=\"hidden\" id=\"editId\">
        <input type=\"hidden\" id=\"editStatusGroup\">
        
        <div style=\"margin-bottom: 15px;\">
          <label style=\"display:block; margin-bottom:5px; font-weight:bold;\">카테고리</label>
          <input type=\"text\" id=\"editCategory\" style=\"width: 100%; padding: 8px; background: var(--surface); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px;\">
        </div>

        <div style=\"margin-bottom: 15px;\">
          <label style=\"display:block; margin-bottom:5px; font-weight:bold;\">요약글 (Summary)</label>
          <textarea id=\"editSummary\" rows=\"2\" style=\"width: 100%; padding: 8px; background: var(--surface); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px;\"></textarea>
        </div>

        <div style=\"margin-bottom: 15px;\">
          <label style=\"display:block; margin-bottom:5px; font-weight:bold;\">상세 설명 (Description)</label>
          <textarea id=\"editDescription\" rows=\"4\" style=\"width: 100%; padding: 8px; background: var(--surface); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px;\"></textarea>
        </div>
        
        <div style=\"margin-bottom: 15px;\">
          <label style=\"display:block; margin-bottom:5px; font-weight:bold;\">운영 상태 (Operating Status)</label>
          <input type=\"text\" id=\"editOperatingStatus\" style=\"width: 100%; padding: 8px; background: var(--surface); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px;\">
        </div>

        <div style=\"display: flex; gap: 10px; justify-content: flex-end;\">
          <button type=\"button\" onclick=\"closeEditModal()\" class=\"btn btn-secondary\" style=\"padding: 8px 16px;\">취소</button>
          <button type=\"submit\" class=\"btn btn-primary\" style=\"padding: 8px 16px; background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer;\">저장 및 승인</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function openEditModal(id, statusGroup) {
      // Find the place from the loaded arrays
      const tbody = document.getElementById('placesBody');
      const placesData = window.lastLoadedPlaces || [];
      const reviewData = window.lastLoadedReview || [];
      
      let place = null;
      if (statusGroup === 'published') {
        place = placesData.find(p => p.id === id);
      } else {
        place = reviewData.find(p => p.id === id);
      }
      
      if (!place) {
        alert('데이터를 찾을 수 없습니다.');
        return;
      }
      
      document.getElementById('editId').value = place.id || '';
      document.getElementById('editStatusGroup').value = statusGroup || '';
      document.getElementById('editCategory').value = place.category || '';
      document.getElementById('editSummary').value = place.summary_ko || '';
      document.getElementById('editDescription').value = place.description_ko || '';
      document.getElementById('editOperatingStatus').value = place.operating_status || '';
      
      let scoreInfo = \? <b>신뢰도 점수:</b> \점<br/>\;
      scoreInfo += \?? <b>리뷰 통계:</b> 총 \개 / 주간 \개 / 격주 \개<br/>\;
      if (place.last_status_checked_at) scoreInfo += \?? <b>최근 확인일:</b> \<br/>\;
      
      document.getElementById('editModalScoreInfo').innerHTML = scoreInfo;
      document.getElementById('editModal').style.display = 'block';
    }
    
    function closeEditModal() {
      document.getElementById('editModal').style.display = 'none';
    }
    
    async function submitEdit(e) {
      e.preventDefault();
      const payload = {
        id: document.getElementById('editId').value,
        statusGroup: document.getElementById('editStatusGroup').value,
        category: document.getElementById('editCategory').value,
        summary_ko: document.getElementById('editSummary').value,
        description_ko: document.getElementById('editDescription').value,
        operating_status: document.getElementById('editOperatingStatus').value
      };
      
      try {
        const res = await fetch('/api/update-place', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        if (res.ok) {
          closeEditModal();
          loadAll();
        } else {
          const err = await res.json();
          alert('저장 실패: ' + err.error);
        }
      } catch (err) {
        alert('네트워크 오류: ' + err.message);
      }
    }
    
    // Store loaded data globally for the modal
    const originalLoadAll = loadAll;
    loadAll = async function() {
      try {
        const [placesRes, reviewRes] = await Promise.all([
          fetch('/data/places.json?t=' + Date.now()),
          fetch('/data/review_needed.json?t=' + Date.now())
        ]);
        if (placesRes.ok) window.lastLoadedPlaces = await placesRes.json();
        if (reviewRes.ok) window.lastLoadedReview = await reviewRes.json();
      } catch(e) {}
      originalLoadAll();
    };
  </script>
\;
html = html.replace('</body>', modalCode + '\\n</body>'); fs.writeFileSync('public/dashboard.html', html);
