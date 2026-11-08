// Video Download Unlimited - Popup Script
// Gerencia exibição de mídia da aba, miniaturas universais, reordenação, fila persistente e cancelamento

document.addEventListener('DOMContentLoaded', async () => {
  const mediaListEl = document.getElementById('media-list');
  const emptyStateEl = document.getElementById('empty-state');
  const pageTitleEl = document.getElementById('page-title');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');
  const btnSidepanel = document.getElementById('btn-sidepanel');
  const btnHistory = document.getElementById('btn-history');

  // Barra de Ações em Lote (Baixar Todos / Selecionados / Cancelar)
  const batchBar = document.getElementById('batch-actions-bar');
  const batchCountEl = document.getElementById('batch-count');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const btnCancelAll = document.getElementById('btn-cancel-all');
  const checkboxSelectAll = document.getElementById('checkbox-select-all');

  // Elementos de Filtros Rápidos
  const filterPills = document.querySelectorAll('.filter-pill');
  const badgeAll = document.getElementById('badge-all');
  const badgePending = document.getElementById('badge-pending');
  const badgeDownloaded = document.getElementById('badge-downloaded');

  // Elementos do Modal de Confirmação
  const confirmModal = document.getElementById('confirm-modal');
  const modalVideoTitle = document.getElementById('modal-video-title');
  const modalBtnCancel = document.getElementById('modal-btn-cancel');
  const modalBtnConfirm = document.getElementById('modal-btn-confirm');

  let currentTab = null;
  let currentMediaList = [];
  let activePendingAction = null;
  const downloadedKeys = new Set();
  const selectedItemIds = new Set(); // Guarda os IDs dos itens selecionados com o checkbox
  let currentFilter = 'all'; // 'all' | 'pending' | 'downloaded'

  // Ícones SVG reutilizáveis
  const ICON_DOWNLOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Baixar`;
  const ICON_DOWNLOADED = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> ✓ Já Baixado`;

  // Ouvinte de progresso de downloads HLS em tempo real
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DOWNLOAD_PROGRESS') {
      const btn = document.querySelector(`.btn-download[data-id="${msg.id}"]`);
      const btnCancel = document.querySelector(`.btn-cancel[data-id="${msg.id}"]`);

      if (btn) {
        if (msg.percent === -2) {
          // Download cancelado pelo usuário
          btn.classList.remove('downloading');
          if (btnCancel) btnCancel.classList.add('hidden');
          btn.innerHTML = btn.classList.contains('downloaded') ? ICON_DOWNLOADED : ICON_DOWNLOAD;
          btn.title = 'Download cancelado';
          updateBatchBar();
        } else if (msg.percent >= 100) {
          // Concluído
          btn.classList.remove('downloading');
          btn.classList.add('downloaded');
          btn.innerHTML = ICON_DOWNLOADED;
          btn.title = 'Este arquivo já foi salvo no computador. Clique para baixar novamente.';
          if (btnCancel) btnCancel.classList.add('hidden');

          // Atualiza o item em memória na lista atual
          const targetItem = currentMediaList.find(m => m.id === msg.id);
          if (targetItem) {
            targetItem.downloaded = true;
          }

          const card = btn.closest('.media-card');
          if (card) {
            markCardAsDownloaded(card);
            card.classList.add('is-downloaded');

            const itemUrl = btn.getAttribute('data-url');
            if (itemUrl) {
              downloadedKeys.add(itemUrl);
              downloadedKeys.add(getVideoKey(itemUrl));
            }

            setTimeout(() => {
              if (card.parentElement === mediaListEl && mediaListEl.lastElementChild !== card) {
                mediaListEl.appendChild(card);
              }
              updateBatchBar();
            }, 400);
          } else {
            updateBatchBar();
          }
        } else if (msg.percent < 0 || (msg.statusText && msg.statusText.startsWith('Erro'))) {
          btn.classList.remove('downloading');
          if (btnCancel) btnCancel.classList.add('hidden');
          btn.innerHTML = `Erro no download`;
          btn.title = msg.statusText || 'Erro no processamento';
          setTimeout(() => {
            btn.innerHTML = btn.classList.contains('downloaded') ? ICON_DOWNLOADED : ICON_DOWNLOAD;
          }, 3500);
        } else if (msg.percent > 0) {
          btn.classList.add('downloading');
          btn.innerHTML = `Baixando ${msg.percent}%`;
          btn.title = msg.statusText || '';
          if (btnCancel) btnCancel.classList.remove('hidden');
        }
      }
    }

    if (msg.type === 'BATCH_QUEUE_COMPLETED') {
      btnCancelAll.classList.add('hidden');
      btnDownloadAll.classList.remove('downloading');
      btnDownloadAll.textContent = '✓ Fila Concluída!';
      setTimeout(() => updateBatchBar(), 2000);
    }
  });

  // Modal de Confirmação
  modalBtnCancel.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    activePendingAction = null;
  });

  modalBtnConfirm.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (typeof activePendingAction === 'function') {
      const action = activePendingAction;
      activePendingAction = null;
      action();
    }
  });

  // Botão Baixar Todos ou Baixar Selecionados
  btnDownloadAll.addEventListener('click', () => {
    let itemsToDownload = [];

    if (selectedItemIds.size > 0) {
      // Baixa os itens marcados manualmente nas caixas de seleção
      itemsToDownload = currentMediaList.filter(item => selectedItemIds.has(item.id));
    } else {
      // Baixa todos os itens pendentes
      itemsToDownload = currentMediaList.filter(item => !checkIfDownloaded(item));
    }

    if (itemsToDownload.length === 0) {
      btnDownloadAll.textContent = '✓ Nenhum vídeo para baixar';
      setTimeout(() => updateBatchBar(), 2000);
      return;
    }

    btnDownloadAll.classList.add('downloading');
    btnDownloadAll.textContent = 'Baixando';
    btnCancelAll.classList.remove('hidden');

    chrome.runtime.sendMessage({
      type: 'START_BATCH_DOWNLOAD',
      items: itemsToDownload
    }, () => {
      // O background processa a fila de forma persistente com concorrência
    });
  });

  // Checkbox Mestre (Selecionar / Desmarcar Todos os visíveis)
  if (checkboxSelectAll) {
    checkboxSelectAll.addEventListener('change', () => {
      const isChecked = checkboxSelectAll.checked;
      const visibleCheckboxes = Array.from(mediaListEl.querySelectorAll('.media-card:not(.hidden) .item-checkbox'));

      visibleCheckboxes.forEach(chk => {
        chk.checked = isChecked;
        const id = chk.getAttribute('data-id');
        if (id) {
          if (isChecked) {
            selectedItemIds.add(id);
          } else {
            selectedItemIds.delete(id);
          }
        }
      });
      updateBatchBar();
    });
  }

  // Filtros de Status (Todos | Pendentes | Baixados)
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.getAttribute('data-filter') || 'all';
      applyFilter();
    });
  });

  // Botão Cancelar Fila (em lote)
  btnCancelAll.addEventListener('click', () => {
    btnCancelAll.classList.add('hidden');
    btnDownloadAll.classList.remove('downloading');
    btnDownloadAll.textContent = 'Cancelando...';

    chrome.runtime.sendMessage({ type: 'CANCEL_ALL_DOWNLOADS' }, () => {
      setTimeout(() => updateBatchBar(), 600);
    });
  });

  // Obter aba ativa
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      currentTab = tabs[0];
      pageTitleEl.textContent = currentTab.title || 'Aba Atual';
      loadMediaForTab(currentTab.id);
    }
  } catch (e) {}

  // Barra de ferramentas superior
  btnRefresh.addEventListener('click', () => {
    if (currentTab && currentTab.id) {
      const url = currentTab.url || '';
      if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
        loadMediaForTab(currentTab.id);
        return;
      }

      chrome.tabs.sendMessage(currentTab.id, { type: 'SCAN_PAGE' }, () => {
        if (chrome.runtime.lastError) {}
        setTimeout(() => loadMediaForTab(currentTab.id), 300);
      });
    }
  });

  btnSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  btnSidepanel.addEventListener('click', async () => {
    if (chrome.sidePanel && chrome.sidePanel.open && currentTab) {
      await chrome.sidePanel.open({ tabId: currentTab.id });
      window.close();
    } else {
      chrome.runtime.openOptionsPage();
    }
  });

  btnHistory.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Carrega mídia da aba atual e cruza com histórico
  async function loadMediaForTab(tabId) {
    const store = await chrome.storage.local.get('history');
    const history = store.history || [];

    downloadedKeys.clear();
    history.forEach(h => {
      if (h.url) {
        downloadedKeys.add(h.url);
        downloadedKeys.add(getVideoKey(h.url));
      }
      if (h.videoKey) {
        downloadedKeys.add(h.videoKey);
      }
    });

    chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId }, (res) => {
      if (chrome.runtime.lastError) return;
      currentMediaList = res && res.media ? res.media : [];
      renderMediaList(currentMediaList);

      // Consulta estado ativo da fila de segundo plano
      syncWithBackgroundQueue();
    });
  }

  // Sincroniza o popup com downloads que estejam rodando no Background
  function syncWithBackgroundQueue() {
    chrome.runtime.sendMessage({ type: 'GET_QUEUE_STATE' }, (res) => {
      if (chrome.runtime.lastError || !res) return;

      if (res.isBatchActive) {
        btnCancelAll.classList.remove('hidden');
        btnDownloadAll.classList.add('downloading');
        btnDownloadAll.textContent = 'Baixando';
      }

      if (res.active && res.active.length > 0) {
        res.active.forEach(a => {
          const btn = document.querySelector(`.btn-download[data-id="${a.id}"]`);
          const btnCancel = document.querySelector(`.btn-cancel[data-id="${a.id}"]`);
          if (btn) {
            btn.classList.add('downloading');
            btn.innerHTML = `Baixando ${a.percent}%`;
            if (btnCancel) btnCancel.classList.remove('hidden');
          }
        });
      }
    });
  }

  // Verifica se o item já foi baixado pelo identificador único do fluxo
  function checkIfDownloaded(item) {
    if (item.downloaded) return true;
    if (downloadedKeys.has(item.url)) return true;
    const vKey = item.videoKey || getVideoKey(item.url);
    if (vKey && downloadedKeys.has(vKey)) return true;
    return false;
  }

  function markCardAsDownloaded(card) {
    const tagsContainer = card.querySelector('.media-tags');
    if (tagsContainer && !tagsContainer.querySelector('.tag-downloaded')) {
      const tag = document.createElement('span');
      tag.className = 'tag tag-downloaded';
      tag.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Baixado`;
      tagsContainer.appendChild(tag);
    }
  }

  // Atualiza as contagens numéricas nos filtros de status
  function updateFilterBadges() {
    if (!currentMediaList) return;
    const total = currentMediaList.length;
    const downloaded = currentMediaList.filter(item => checkIfDownloaded(item)).length;
    const pending = total - downloaded;

    if (badgeAll) badgeAll.textContent = total;
    if (badgePending) badgePending.textContent = pending;
    if (badgeDownloaded) badgeDownloaded.textContent = downloaded;
  }

  // Aplica o filtro de status (Todos | Pendentes | Baixados)
  function applyFilter() {
    const cards = mediaListEl.querySelectorAll('.media-card');

    cards.forEach(card => {
      const isDown = card.classList.contains('is-downloaded');

      let matchesFilter = true;
      if (currentFilter === 'pending' && isDown) matchesFilter = false;
      if (currentFilter === 'downloaded' && !isDown) matchesFilter = false;

      if (matchesFilter) {
        card.classList.remove('hidden');
      } else {
        card.classList.add('hidden');
      }
    });

    updateBatchBar();
  }

  // Atualiza a barra de downloads em lote e sincroniza seleção
  function updateBatchBar() {
    if (!currentMediaList || currentMediaList.length === 0) {
      batchBar.classList.add('hidden');
      return;
    }

    batchBar.classList.remove('hidden');
    updateFilterBadges();

    const pending = currentMediaList.filter(item => !checkIfDownloaded(item));
    const selectedCount = selectedItemIds.size;

    // Se estiver ocorrendo download da fila no background
    if (btnDownloadAll.classList.contains('downloading')) {
      btnCancelAll.classList.remove('hidden');
      btnDownloadAll.disabled = true;
      btnDownloadAll.textContent = 'Baixando';
      batchCountEl.textContent = `${pending.length} pendente(s)`;
      return;
    }

    btnCancelAll.classList.add('hidden');

    if (selectedCount > 0) {
      // Modo Seleção Manual por Checkboxes
      batchCountEl.textContent = `${selectedCount} selecionado(s)`;
      btnDownloadAll.disabled = false;
      btnDownloadAll.style.opacity = '1';
      btnDownloadAll.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Baixar Selecionados (${selectedCount})`;
    } else {
      // Modo Padrão
      if (pending.length === 0) {
        batchCountEl.textContent = '✓ Todos já baixados';
        btnDownloadAll.disabled = true;
        btnDownloadAll.style.opacity = '0.6';
        btnDownloadAll.classList.remove('downloading');
        btnDownloadAll.innerHTML = `✓ Todos Baixados`;
      } else {
        batchCountEl.textContent = `${pending.length} vídeo(s) pendente(s)`;
        btnDownloadAll.disabled = false;
        btnDownloadAll.style.opacity = '1';
        btnDownloadAll.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Baixar Todos (${pending.length})`;
      }
    }

    // Sincroniza estado visual do checkbox mestre (Selecionar Todos)
    if (checkboxSelectAll) {
      const visibleCheckboxes = Array.from(mediaListEl.querySelectorAll('.media-card:not(.hidden) .item-checkbox'));
      if (visibleCheckboxes.length > 0 && visibleCheckboxes.every(c => c.checked)) {
        checkboxSelectAll.checked = true;
        checkboxSelectAll.indeterminate = false;
      } else if (visibleCheckboxes.some(c => c.checked)) {
        checkboxSelectAll.checked = false;
        checkboxSelectAll.indeterminate = true;
      } else {
        checkboxSelectAll.checked = false;
        checkboxSelectAll.indeterminate = false;
      }
    }
  }

  // Renderiza a lista de cards de mídia reordenada (não baixados no topo, baixados no final)
  function renderMediaList(media) {
    mediaListEl.innerHTML = '';

    if (!media || media.length === 0) {
      emptyStateEl.classList.remove('hidden');
      batchBar.classList.add('hidden');
      updateFilterBadges();
      return;
    }

    emptyStateEl.classList.add('hidden');

    // 1. Reordenação automática: Não baixados no topo, já baixados no final da lista
    const sortedMedia = [...media].sort((a, b) => {
      const aDown = checkIfDownloaded(a) ? 1 : 0;
      const bDown = checkIfDownloaded(b) ? 1 : 0;
      if (aDown !== bDown) return aDown - bDown;
      return (a.videoIndex || 0) - (b.videoIndex || 0);
    });

    sortedMedia.forEach((item) => {
      const card = document.createElement('div');
      const isDownloaded = checkIfDownloaded(item);
      card.className = isDownloaded ? 'media-card is-downloaded' : 'media-card';

      const isAudio = item.type === 'audio';
      const iconSvg = isAudio ?
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>` :
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;

      const downloadedTagHtml = isDownloaded ?
        `<span class="tag tag-downloaded"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Baixado</span>` : '';

      const btnClass = isDownloaded ? 'btn-download downloaded' : 'btn-download';
      const btnLabel = isDownloaded ? ICON_DOWNLOADED : ICON_DOWNLOAD;
      const btnTitle = isDownloaded ? 'Este arquivo já foi salvo no computador. Clique para baixar novamente.' : 'Baixar vídeo';

      const thumbnailHtml = item.thumbnail ?
        `<img src="${escapeHtml(item.thumbnail)}" class="media-thumb" alt="Preview">
         <div class="media-fallback-icon" style="display:none;">${iconSvg}</div>` :
        `<div class="media-fallback-icon">${iconSvg}</div>`;

      const isChecked = selectedItemIds.has(item.id);

      card.innerHTML = `
        <div class="media-info">
          <label class="custom-checkbox item-checkbox-label" title="Selecionar para baixar">
            <input type="checkbox" class="item-checkbox" data-id="${escapeHtml(item.id)}" ${isChecked ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
          <div class="media-icon">${thumbnailHtml}</div>
          <div class="media-details">
            <div class="media-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="media-tags">
              <span class="tag tag-quality">${escapeHtml(item.quality || 'HD')}</span>
              <span class="tag tag-format">${escapeHtml(item.format || 'MP4')}</span>
              ${downloadedTagHtml}
            </div>
          </div>
        </div>
        <div class="media-actions">
          <button class="${btnClass}" data-id="${escapeHtml(item.id)}" data-url="${escapeHtml(item.url)}" title="${btnTitle}">
            ${btnLabel}
          </button>
          <button class="btn-cancel hidden" data-id="${escapeHtml(item.id)}" title="Cancelar download">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <button class="btn-copy" title="Copiar Link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
      `;

      // Checkbox individual de seleção
      const itemCheckbox = card.querySelector('.item-checkbox');
      if (itemCheckbox) {
        itemCheckbox.addEventListener('change', (e) => {
          e.stopPropagation();
          if (itemCheckbox.checked) {
            selectedItemIds.add(item.id);
          } else {
            selectedItemIds.delete(item.id);
          }
          updateBatchBar();
        });
      }

      // Fallback seguro de erro na miniatura (compatível com CSP)
      const thumbImg = card.querySelector('.media-thumb');
      if (thumbImg) {
        thumbImg.addEventListener('error', () => {
          thumbImg.style.display = 'none';
          const fallback = card.querySelector('.media-fallback-icon');
          if (fallback) fallback.style.display = 'flex';
        });
      }

      // Evento de Clique no botão Baixar
      const btnDownload = card.querySelector('.btn-download');
      btnDownload.addEventListener('click', () => {
        if (btnDownload.classList.contains('downloading')) return;

        const alreadySaved = btnDownload.classList.contains('downloaded') || checkIfDownloaded(item);

        if (alreadySaved) {
          modalVideoTitle.textContent = item.title || 'Vídeo';
          activePendingAction = () => {
            triggerDownload(item, btnDownload, card);
          };
          confirmModal.classList.remove('hidden');
        } else {
          triggerDownload(item, btnDownload, card);
        }
      });

      // Evento de Clique no botão Cancelar Individual
      const btnCancel = card.querySelector('.btn-cancel');
      btnCancel.addEventListener('click', () => {
        btnCancel.classList.add('hidden');
        btnDownload.classList.remove('downloading');
        btnDownload.textContent = 'Cancelando...';

        chrome.runtime.sendMessage({
          type: 'CANCEL_DOWNLOAD',
          itemId: item.id
        }, () => {
          setTimeout(() => updateBatchBar(), 400);
        });
      });

      // Evento de Copiar Link
      const btnCopy = card.querySelector('.btn-copy');
      btnCopy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.url);
          btnCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          setTimeout(() => {
            btnCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
          }, 2000);
        } catch (e) {}
      });

      mediaListEl.appendChild(card);
    });

    applyFilter();
  }

  // Dispara o download da mídia individual
  function triggerDownload(item, btnDownload, card) {
    btnDownload.classList.add('downloading');
    btnDownload.innerHTML = `Iniciando...`;

    const btnCancel = card ? card.querySelector('.btn-cancel') : null;
    if (btnCancel) btnCancel.classList.remove('hidden');

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      payload: item
    }, (res) => {
      if (chrome.runtime.lastError) {
        btnDownload.classList.remove('downloading');
        if (btnCancel) btnCancel.classList.add('hidden');
        btnDownload.textContent = 'Erro ao baixar';
        return;
      }

      if (res && res.success) {
        if (res.mode === 'hls_assembling') {
          btnDownload.innerHTML = `Baixando...`;
        } else {
          btnDownload.classList.remove('downloading');
          btnDownload.classList.add('downloaded');
          btnDownload.innerHTML = ICON_DOWNLOADED;
          btnDownload.title = 'Este arquivo já foi salvo no computador. Clique para baixar novamente.';
          if (btnCancel) btnCancel.classList.add('hidden');

          if (card) {
            markCardAsDownloaded(card);
            card.classList.add('is-downloaded');
            setTimeout(() => {
              if (card.parentElement === mediaListEl && mediaListEl.lastElementChild !== card) {
                mediaListEl.appendChild(card);
              }
            }, 600);
          }

          downloadedKeys.add(item.url);
          downloadedKeys.add(getVideoKey(item.url));
          updateBatchBar();
        }
      } else {
        btnDownload.classList.remove('downloading');
        if (btnCancel) btnCancel.classList.add('hidden');
        btnDownload.textContent = 'Erro ao baixar';
      }
    });
  }

  function getVideoKey(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      // 0. YouTube
      if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
        if (u.searchParams.has('v')) {
          return `youtube_${u.searchParams.get('v')}`;
        }
        if (u.pathname.includes('/shorts/')) {
          const parts = u.pathname.split('/shorts/')[1];
          return `youtube_${parts.split('/')[0].split('?')[0]}`;
        }
        const parts = u.pathname.replace(/^\//, '').split('/');
        if (parts[0]) return `youtube_${parts[0]}`;
      }

      const uuidMatch = u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) return `${u.host}_${uuidMatch[0].toLowerCase()}`;

      const hex32Matches = u.pathname.match(/[0-9a-f]{32}/gi);
      if (hex32Matches && hex32Matches.length > 0) {
        return `${u.host}_${hex32Matches[hex32Matches.length - 1].toLowerCase()}`;
      }

      if (u.searchParams.has('video')) {
        return `${u.host}_${u.searchParams.get('video').toLowerCase()}`;
      }

      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 1) {
        return `${u.host}_${parts.slice(0, -1).join('/')}`;
      }
      return `${u.host}_${u.pathname}`;
    } catch (e) {
      return url;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});
