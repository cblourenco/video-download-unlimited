// Video Download Unlimited - Sidepanel Script
document.addEventListener('DOMContentLoaded', () => {
  const tabActive = document.getElementById('tab-active');
  const tabHistory = document.getElementById('tab-history');
  const secCurrent = document.getElementById('section-current');
  const secHistory = document.getElementById('section-history');
  const currentList = document.getElementById('current-media-list');
  const historyList = document.getElementById('history-list');
  const btnClearHistory = document.getElementById('btn-clear-history');

  tabActive.addEventListener('click', () => {
    tabActive.classList.add('active');
    tabHistory.classList.remove('active');
    secCurrent.classList.remove('hidden');
    secHistory.classList.add('hidden');
    loadActiveMedia();
  });

  tabHistory.addEventListener('click', () => {
    tabHistory.classList.add('active');
    tabActive.classList.remove('active');
    secHistory.classList.remove('hidden');
    secCurrent.classList.add('hidden');
    loadHistory();
  });

  btnClearHistory.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
      if (chrome.runtime.lastError) return;
      loadHistory();
    });
  });

  async function loadActiveMedia() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) return;

      chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: tabs[0].id }, (res) => {
        if (chrome.runtime.lastError) return;
        const media = res && res.media ? res.media : [];
        currentList.innerHTML = '';
        if (!media.length) {
          currentList.innerHTML = '<p style="font-size:12px;color:#64748B;">Nenhuma mídia detectada na aba atual.</p>';
          return;
        }
        media.forEach(m => {
          const item = document.createElement('div');
          item.className = 'panel-card';
          const isDone = m.downloaded;
          const statusText = isDone ? '<span style="color:#10B981;"> • ✓ Baixado</span>' : '';
          item.innerHTML = `
            <h4>${escapeHtml(m.title)}</h4>
            <span style="font-size:10px;color:#06B6D4;font-weight:700;">${m.quality} • ${m.format}${statusText}</span>
          `;
          currentList.appendChild(item);
        });
      });
    } catch (e) {}
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
      if (chrome.runtime.lastError) return;
      const history = res && res.history ? res.history : [];
      historyList.innerHTML = '';
      if (!history.length) {
        historyList.innerHTML = '<p style="font-size:12px;color:#64748B;">Nenhum download concluído ainda.</p>';
        return;
      }
      history.forEach(h => {
        const item = document.createElement('div');
        item.className = 'panel-card';
        const date = new Date(h.timestamp).toLocaleDateString('pt-BR');
        item.innerHTML = `
          <h4>${escapeHtml(h.title)}</h4>
          <span style="font-size:10px;color:#94A3B8;">${h.format} • ${date}</span>
        `;
        historyList.appendChild(item);
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  loadActiveMedia();
});
