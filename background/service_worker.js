// Video Download Unlimited - Background Service Worker
// Gerencia a detecção de mídia na rede, fila de downloads, histórico e badge do Chrome

const tabMediaMap = new Map(); // tabId -> Map(mediaId -> mediaItem)
const tabThumbnailsMap = new Map(); // tabId -> Array(thumbnailUrls)
const activeDownloads = new Map(); // itemId -> { item, isHls, nativeDownloadId, percent, statusText }
const downloadQueue = []; // Fila de itens pendentes para download em segundo plano
let isQueueProcessing = false;
const queueItemResolvers = new Map(); // itemId -> resolve function

function completeQueueItem(itemId) {
  const resolver = queueItemResolvers.get(itemId);
  if (resolver) {
    queueItemResolvers.delete(itemId);
    resolver();
  }
}

function markItemAsDownloadedInTabs(item) {
  const vKey = item.videoKey || getVideoKey(item.url);
  for (const [tId, mediaMap] of tabMediaMap.entries()) {
    for (const [key, mediaItem] of mediaMap.entries()) {
      if (mediaItem.id === item.id || mediaItem.url === item.url || (vKey && getVideoKey(mediaItem.url) === vKey)) {
        mediaItem.downloaded = true;
      }
    }
  }
}

function isItemAlreadyDownloaded(item) {
  if (item.downloaded) return true;
  const vKey = item.videoKey || getVideoKey(item.url);
  for (const [tId, mediaMap] of tabMediaMap.entries()) {
    for (const [key, mediaItem] of mediaMap.entries()) {
      if (mediaItem.id === item.id || mediaItem.url === item.url || (vKey && getVideoKey(mediaItem.url) === vKey)) {
        if (mediaItem.downloaded) return true;
      }
    }
  }
  return false;
}

function saveDownloadToHistory(downloadId, item, formatStr) {
  chrome.storage.local.get(['history', 'settings'], (store) => {
    const history = store.history || [];
    history.unshift({
      id: downloadId,
      title: item.title,
      url: item.url,
      videoKey: item.videoKey || getVideoKey(item.url),
      format: formatStr || item.format || 'MP4',
      quality: item.quality || 'HD',
      timestamp: Date.now()
    });
    if (history.length > 50) history.pop();
    chrome.storage.local.set({ history });

    const settings = store.settings || DEFAULT_SETTINGS;
    if (settings.desktopNotifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Download Concluído!',
        message: `${item.title} salvo com sucesso.`
      });
    }
  });
}

// Configurações padrão
const DEFAULT_SETTINGS = {
  maxConcurrent: 2,
  preferredQuality: 'highest',
  filenamePattern: '{title} [{quality}]',
  subfolderMode: 'site', // 'none' | 'site' | 'date'
  desktopNotifications: true,
  theme: 'dark'
};

// Gera o caminho de destino relativo à pasta de Downloads respeitando subpastas configuradas
function getDownloadFilePath(item, baseFilename, settings) {
  const mode = (settings && settings.subfolderMode) || 'site';
  if (mode === 'none') {
    return baseFilename;
  }
  if (mode === 'date') {
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `Video Download Unlimited/${monthStr}/${baseFilename}`;
  }
  // 'site'
  let siteName = 'Geral';
  try {
    if (item.pageUrl) {
      siteName = new URL(item.pageUrl).hostname.replace(/^www\./, '');
    } else if (item.url) {
      siteName = new URL(item.url).hostname.replace(/^www\./, '');
    }
  } catch (e) {}
  siteName = siteName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return `Video Download Unlimited/${siteName}/${baseFilename}`;
}

// Inicializa configurações
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('settings');
  if (!current.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, history: [] });
  }
});

// Sniffer de rede para interceptação de requisições de mídia
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const url = details.url;

    // Ignora fatias, pedaços de streaming e trilhas de miniaturas/sprites
    if (isIgnoredStreamOrChunk(url)) {
      return;
    }

    const headers = details.responseHeaders || [];
    let contentType = '';
    let contentLength = 0;

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value.toLowerCase();
      if (name === 'content-length') contentLength = parseInt(h.value, 10) || 0;
    }

    const isHls = url.includes('.m3u8') || url.includes('.hls') || contentType.includes('mpegurl');
    const isDash = url.includes('.mpd') || contentType.includes('dash+xml');
    const isManifest = isHls || isDash;

    const isMedia = contentType.startsWith('video/') ||
                    contentType.startsWith('audio/') ||
                    /\.(mp4|webm|m4v|mkv|mp3|m4a|aac)(\?|$)/i.test(url);

    if (isManifest || (isMedia && (contentLength > 100000 || contentLength === 0))) {
      registerTabMedia(details.tabId, {
        url: url,
        type: isManifest ? 'stream' : (contentType.startsWith('audio/') ? 'audio' : 'video'),
        format: isManifest ? (isDash ? 'DASH' : 'HLS') : getFormatFromUrlOrType(url, contentType),
        size: contentLength,
        quality: isManifest ? 'Multi-Res' : guessQuality(url, contentType),
        timestamp: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Filtra pedaços, fragmentos e trilhas de miniaturas/sprites para não poluir a interface
function isIgnoredStreamOrChunk(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();

    // 1. Ignora trilhas de miniaturas da barra de progresso (storyboard, sprites, thumbnails)
    if (/(?:thumb|thumbnail|sprite|storyboard|preview[-_]?\d*|tile[-_]?\d*)\.(?:m3u8|mpd|jpg|jpeg|png|vtt)($|\?)/i.test(url)) return true;
    if (/\/thumbnail\./i.test(path) || /\/thumbnails\//i.test(path) || /\/sprites\//i.test(path) || /\/storyboard\//i.test(path)) return true;

    // 2. Fragmentos comuns de HLS/DASH, chaves e legendas soltas
    if (/\.(ts|m4s|key|vtt|srt)($|\?)/i.test(path)) return true;

    // 3. Padrões de fatias (segment-1, chunk-2, frag-3, part-4, range/...)
    if (/(?:segment|seg[-_]?\d+|chunk[-_]?\d+|frag[-_]?\d+|part[-_]?\d+|\/range\/\d+|init\.mp4)/i.test(path)) return true;
    if (/[\/_-]\d{3,6}\.(mp4|webm|ts|m4s)/i.test(path)) return true;

    // 4. Query params de range ou segment
    if (u.searchParams.has('range') || u.searchParams.has('sq') || u.searchParams.has('segment')) return true;
  } catch (e) {
    if (/\.(ts|m4s|key)/i.test(url)) return true;
  }
  return false;
}

function getFormatFromUrlOrType(url, contentType) {
  if (contentType.includes('mp4')) return 'MP4';
  if (contentType.includes('webm')) return 'WEBM';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'MP3';
  if (contentType.includes('m4a') || contentType.includes('aac')) return 'M4A';
  try {
    const ext = new URL(url).pathname.split('.').pop().toUpperCase();
    if (['MP4', 'WEBM', 'MKV', 'MP3', 'M4A'].includes(ext)) return ext;
  } catch {}
  return 'MP4';
}

function guessQuality(url, contentType) {
  if (contentType.includes('audio')) return 'Áudio';
  if (/2160|4k/i.test(url)) return '4K (2160p)';
  if (/1440|2k/i.test(url)) return '2K (1440p)';
  if (/1080/i.test(url)) return '1080p';
  if (/720/i.test(url)) return '720p';
  if (/480/i.test(url)) return '480p';
  if (/360/i.test(url)) return '360p';
  return 'HD';
}

// Identificador único por fluxo/vídeo para agrupar master e variantes
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

    // 1. UUID com hífens (Spalla e outros provedores)
    const uuidMatch = u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      return `${u.host}_${uuidMatch[0].toLowerCase()}`;
    }
    // 2. Hash hex de 32 caracteres (LiquidPlatform e outros)
    const hex32Matches = u.pathname.match(/[0-9a-f]{32}/gi);
    if (hex32Matches && hex32Matches.length > 0) {
      return `${u.host}_${hex32Matches[hex32Matches.length - 1].toLowerCase()}`;
    }
    // 3. Parâmetro de busca video=?
    if (u.searchParams.has('video')) {
      return `${u.host}_${u.searchParams.get('video').toLowerCase()}`;
    }
    // 4. Diretório pai no caminho
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 1) {
      return `${u.host}_${parts.slice(0, -1).join('/')}`;
    }
    return `${u.host}_${u.pathname}`;
  } catch (e) {
    return url;
  }
}

// Extrai um ID curto amigável do fluxo para diferenciar arquivos no disco
function extractVideoShortId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const uuidMatch = u.pathname.match(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) return uuidMatch[1].toLowerCase();

    const hex32Matches = u.pathname.match(/[0-9a-f]{32}/gi);
    if (hex32Matches && hex32Matches.length > 0) {
      return hex32Matches[hex32Matches.length - 1].substring(0, 8).toLowerCase();
    }

    if (u.searchParams.has('video')) {
      return u.searchParams.get('video').substring(0, 8).toLowerCase();
    }
  } catch (e) {}
  return '';
}

// Extrai miniaturas de padrões universais de vídeo conhecidos na web
function extractUniversalThumbnail(url) {
  if (!url) return '';
  try {
    const u = new URL(url);

    // 1. Spalla CDN (imagem de preview oficial)
    const uuidMatch = u.pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch && (u.host.includes('spalla.io') || u.pathname.includes('spalla'))) {
      return `https://assets.spalla.io/${uuidMatch[1]}/preview-50.png`;
    }

    // 2. YouTube
    const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/i);
    if (ytMatch) {
      return `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
    }

    // 3. Vimeo
    const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (vimeoMatch) {
      return `https://vumbnail.com/${vimeoMatch[1]}.jpg`;
    }

    // 4. Dailymotion
    const dmMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/i);
    if (dmMatch) {
      return `https://www.dailymotion.com/thumbnail/video/${dmMatch[1]}`;
    }
  } catch (e) {}
  return '';
}

function registerTabMedia(tabId, item) {
  if (!tabMediaMap.has(tabId)) {
    tabMediaMap.set(tabId, new Map());
  }

  const map = tabMediaMap.get(tabId);
  const videoKey = getVideoKey(item.url);

  // Evita duplicatas do mesmo fluxo na aba (ex: master e sub-variantes de resolução)
  for (const [existingUrl, existingItem] of map.entries()) {
    if (existingUrl === item.url) return;

    if (getVideoKey(existingUrl) === videoKey) {
      const isCurrentMaster = item.url.includes('.hls') || (item.url.includes('.m3u8') && !item.url.includes('playlist-'));
      const isExistingMaster = existingUrl.includes('.hls') || (existingUrl.includes('.m3u8') && !existingUrl.includes('playlist-'));

      if (isCurrentMaster && !isExistingMaster) {
        map.delete(existingUrl);
        map.set(item.url, { ...existingItem, ...item, id: existingItem.id, videoKey: videoKey });
        updateBadge(tabId);
      }
      return;
    }
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const baseTitle = cleanTitle(tab.title || 'Vídeo');
    const favicon = tab.favIconUrl || '';

    // Numeração sequencial (#01, #02...) e ID curto para feed/timelines
    const videoIndex = map.size + 1;
    const indexStr = String(videoIndex).padStart(2, '0');
    const shortId = extractVideoShortId(item.url);
    const idSuffix = shortId ? ` [${shortId}]` : '';

    // Se o item for do YouTube, preserva o título real do vídeo
    let title;
    if ((item.source === 'youtube' || item.type === 'youtube') && item.title) {
      title = cleanTitle(item.title);
    } else {
      title = `${baseTitle} #${indexStr}${idSuffix}`;
    }

    // Determina a miniatura do vídeo (universal ou coletada na página)
    let thumbnail = item.thumbnail || extractUniversalThumbnail(item.url);
    if (!thumbnail && tabThumbnailsMap.has(tabId)) {
      const thumbs = tabThumbnailsMap.get(tabId);
      thumbnail = thumbs[map.size] || thumbs[0] || '';
    }

    const finalItem = {
      id: Math.random().toString(36).substring(2, 9),
      videoKey: videoKey,
      videoIndex: videoIndex,
      title: title,
      baseTitle: baseTitle,
      thumbnail: thumbnail,
      favicon: favicon,
      ...item
    };
    if (thumbnail) finalItem.thumbnail = thumbnail;
    map.set(item.url, finalItem);
    updateBadge(tabId);
  });
}

function cleanTitle(rawTitle) {
  if (!rawTitle) return 'Video_Download';
  return rawTitle
    .replace(/\|/g, '-')
    .replace(/[\\/:*?"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Video_Download';
}

// Atualiza o contador de mídia no ícone da extensão
function updateBadge(tabId) {
  const map = tabMediaMap.get(tabId);
  const count = map ? map.size : 0;

  try {
    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: count.toString() }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#06B6D4' }).catch(() => {});
      chrome.action.setIcon({
        tabId,
        path: {
          '16': '/icons/icon-16.png',
          '32': '/icons/icon-32.png',
          '48': '/icons/icon-48.png',
          '128': '/icons/icon-128.png'
        }
      }).catch(() => {});
    } else {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setIcon({
        tabId,
        path: {
          '48': '/icons/icon-48-grey.png',
          '128': '/icons/icon-128-grey.png'
        }
      }).catch(() => {});
    }
  } catch (e) {}
}

// Limpeza ao trocar de aba ou fechar
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabMediaMap.delete(tabId);
    tabThumbnailsMap.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  tabThumbnailsMap.delete(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
});

// Garante que o documento offscreen está ativo para operações de Blob
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'engine/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Processamento e montagem de fluxos HLS em MP4'
  });
}

// Comunicação com o Popup, Content Scripts e Offscreen
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'THUMBNAIL_DISCOVERED' && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabThumbnailsMap.has(tabId)) {
      tabThumbnailsMap.set(tabId, []);
    }
    const list = tabThumbnailsMap.get(tabId);
    if (!list.includes(msg.thumbnail)) {
      list.push(msg.thumbnail);
    }

    // Associa a miniatura aos itens já cadastrados que não possuam miniatura
    const mediaMap = tabMediaMap.get(tabId);
    if (mediaMap) {
      let idx = 0;
      for (const mItem of mediaMap.values()) {
        if (!mItem.thumbnail && list[idx]) {
          mItem.thumbnail = list[idx];
        }
        idx++;
      }
    }
    sendResponse({ status: 'ok' });
    return true;
  }

  if (msg.type === 'MEDIA_DETECTED' && sender.tab) {
    registerTabMedia(sender.tab.id, msg.payload);
    sendResponse({ status: 'registered' });
    return true;
  }

  if (msg.type === 'GET_TAB_MEDIA') {
    const tabId = msg.tabId;
    const mediaList = tabMediaMap.has(tabId) ? Array.from(tabMediaMap.get(tabId).values()) : [];
    sendResponse({ media: mediaList });
    return true;
  }

  if (msg.type === 'DOWNLOAD_MEDIA') {
    startDownload(msg.payload, sendResponse);
    return true;
  }

  // Fila de downloads em segundo plano (persiste mesmo ao fechar o popup ou trocar de aba)
  if (msg.type === 'START_BATCH_DOWNLOAD') {
    const items = msg.items || [];
    for (const it of items) {
      if (!activeDownloads.has(it.id) && !downloadQueue.some(q => q.id === it.id)) {
        downloadQueue.push(it);
      }
    }
    processDownloadQueue();
    sendResponse({ status: 'batch_started', queueLength: downloadQueue.length });
    return true;
  }

  // Cancelar download individual
  if (msg.type === 'CANCEL_DOWNLOAD') {
    const itemId = msg.itemId;
    // Remove da fila se estiver aguardando
    const qIdx = downloadQueue.findIndex(it => it.id === itemId);
    if (qIdx !== -1) {
      downloadQueue.splice(qIdx, 1);
    }

    // Cancela o processo ativo
    const active = activeDownloads.get(itemId);
    if (active) {
      if (active.isHls) {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'CANCEL_HLS_DOWNLOAD',
          itemId: itemId
        }).catch(() => {});
      } else if (active.nativeDownloadId) {
        chrome.downloads.cancel(active.nativeDownloadId).catch(() => {});
      }
      activeDownloads.delete(itemId);
    }

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      id: itemId,
      percent: -2,
      statusText: 'Download cancelado'
    }).catch(() => {});

    // Destrava a fila caso este item fosse o item atual em execução
    completeQueueItem(itemId);

    sendResponse({ status: 'cancelled' });
    return true;
  }

  // Cancelar todos os downloads (em lote)
  if (msg.type === 'CANCEL_ALL_DOWNLOADS') {
    downloadQueue.length = 0;
    isQueueProcessing = false;

    for (const [id, active] of activeDownloads.entries()) {
      if (active.isHls) {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'CANCEL_HLS_DOWNLOAD',
          itemId: id
        }).catch(() => {});
      } else if (active.nativeDownloadId) {
        chrome.downloads.cancel(active.nativeDownloadId).catch(() => {});
      }

      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        id: id,
        percent: -2,
        statusText: 'Download cancelado'
      }).catch(() => {});
    }
    activeDownloads.clear();

    // Libera qualquer resolver pendente na fila
    for (const [id, resolver] of queueItemResolvers.entries()) {
      resolver();
    }
    queueItemResolvers.clear();

    sendResponse({ status: 'all_cancelled' });
    return true;
  }

  // Consulta o estado atual da fila de segundo plano
  if (msg.type === 'GET_QUEUE_STATE') {
    const activeList = Array.from(activeDownloads.values()).map(a => ({
      id: a.item.id,
      percent: a.percent || 0,
      statusText: a.statusText || 'Baixando...'
    }));
    sendResponse({
      active: activeList,
      isBatchActive: isQueueProcessing || downloadQueue.length > 0,
      queueCount: downloadQueue.length
    });
    return true;
  }

  // Monitora progresso vindo de offscreen ou outros contextos
  if (msg.type === 'DOWNLOAD_PROGRESS') {
    const active = activeDownloads.get(msg.id);
    if (active) {
      active.percent = msg.percent;
      active.statusText = msg.statusText;
      if (msg.percent >= 100 || msg.percent < 0) {
        activeDownloads.delete(msg.id);
        if (msg.percent < 0) {
          // Em caso de erro ou cancelamento reportado pelo offscreen, avança a fila
          completeQueueItem(msg.id);
        }
      }
    }
  }

  // Recebe o BlobUrl final montado pelo Offscreen Document e grava via chrome.downloads
  if (msg.type === 'TRIGGER_FINAL_DOWNLOAD') {
    const { blobUrl, filename, item } = msg;

    chrome.storage.local.get('settings', (store) => {
      const settings = store.settings || DEFAULT_SETTINGS;
      const targetFilePath = getDownloadFilePath(item, filename, settings);

      chrome.downloads.download({
        url: blobUrl,
        filename: targetFilePath,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        activeDownloads.delete(item.id);

        if (chrome.runtime.lastError) {
          console.error('Erro ao acionar download no service worker:', chrome.runtime.lastError);
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS',
            id: item.id,
            percent: -1,
            statusText: `Erro: ${chrome.runtime.lastError.message}`
          }).catch(() => {});
          completeQueueItem(item.id);
          return;
        }

        // Notifica conclusão de 100% para o Popup e telas abertas
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          id: item.id,
          percent: 100,
          statusText: 'Download Concluído!'
        }).catch(() => {});

        // Marca no mapa de mídias da aba
        markItemAsDownloadedInTabs(item);

        // Salva no histórico e notifica desktop
        saveDownloadToHistory(downloadId, item, 'MP4 (HLS)');

        // Avança a fila do background imediatamente!
        completeQueueItem(item.id);

        // Revoga o blob após 2 minutos
        setTimeout(() => {
          chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'REVOKE_BLOB',
            blobUrl: blobUrl
          }).catch(() => {});
        }, 120000);
      });
    });

    sendResponse({ status: 'download_started' });
    return true;
  }

  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get('history', (res) => {
      sendResponse({ history: res.history || [] });
    });
    return true;
  }

  if (msg.type === 'CLEAR_HISTORY') {
    chrome.storage.local.set({ history: [] }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }
});

// Fila de execução de downloads em segundo plano com concorrência configurável
async function processDownloadQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  const store = await chrome.storage.local.get('settings');
  const settings = store.settings || DEFAULT_SETTINGS;
  const maxConcurrent = Math.min(Math.max(parseInt(settings.maxConcurrent, 10) || 2, 1), 3);

  async function worker() {
    while (downloadQueue.length > 0) {
      const nextItem = downloadQueue.shift();
      if (!nextItem) break;

      // Se o item já tiver sido baixado, passa para o próximo sem refazer download
      if (isItemAlreadyDownloaded(nextItem)) {
        continue;
      }

      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            queueItemResolvers.delete(nextItem.id);
            resolve();
          }
        };

        queueItemResolvers.set(nextItem.id, done);

        startDownload(nextItem, (res) => {
          if (!res || !res.success) {
            console.warn('Falha ao iniciar download de item da fila:', nextItem.title, res && res.error);
            setTimeout(done, 1000);
          }
        });

        // Timeout de segurança: 120 segundos por vídeo para evitar bloqueio caso a conexão caia
        setTimeout(() => {
          if (!settled) {
            console.warn('Timeout de segurança atingido para item da fila:', nextItem.title);
            done();
          }
        }, 120000);
      });

      // Pausa suave de 600ms entre downloads para liberar threads
      if (downloadQueue.length > 0) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }

  // Executa trabalhadores em paralelo de acordo com a concorrência configurada
  const workers = [];
  for (let i = 0; i < maxConcurrent; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  isQueueProcessing = false;
  chrome.runtime.sendMessage({ type: 'BATCH_QUEUE_COMPLETED' }).catch(() => {});
}

// Gerenciador de Downloads
async function startDownload(item, sendResponse) {
  try {
    // Tratamento isolado para vídeos do YouTube
    const isYouTube = item.type === 'youtube' || item.source === 'youtube' || (item.url && (item.url.includes('youtube.com') || item.url.includes('youtu.be')));
    if (isYouTube) {
      return handleYouTubeDownload(item, sendResponse);
    }

    const isHls = item.type === 'stream' || item.format === 'HLS' || item.url.includes('.m3u8') || item.url.includes('.hls');

    activeDownloads.set(item.id, {
      item: item,
      isHls: isHls,
      percent: 5,
      statusText: 'Iniciando...'
    });

    if (isHls) {
      await ensureOffscreenDocument();
      setTimeout(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'PROCESS_HLS_DOWNLOAD',
          payload: item
        });
      }, 150);

      sendResponse({ success: true, mode: 'hls_assembling' });
      return;
    }

    // Download Direto de arquivos únicos (MP4/WebM/MP3)
    const store = await chrome.storage.local.get(['settings', 'history']);
    const settings = store.settings || DEFAULT_SETTINGS;
    const safeTitle = cleanTitle(item.title);
    const ext = item.format ? item.format.toLowerCase() : 'mp4';
    const filename = `${safeTitle}.${ext}`;
    const targetFilePath = getDownloadFilePath(item, filename, settings);

    chrome.downloads.download({
      url: item.url,
      filename: targetFilePath,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      activeDownloads.delete(item.id);

      if (chrome.runtime.lastError) {
        completeQueueItem(item.id);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      const active = activeDownloads.get(item.id);
      if (active) {
        active.nativeDownloadId = downloadId;
      }

      // Marca no mapa de mídias da aba
      markItemAsDownloadedInTabs(item);

      // Salva no histórico
      saveDownloadToHistory(downloadId, item, item.format);

      // Notifica progresso 100%
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        id: item.id,
        percent: 100,
        statusText: 'Download Concluído!'
      }).catch(() => {});

      // Avança a fila
      completeQueueItem(item.id);

      sendResponse({ success: true, downloadId });
    });
  } catch (err) {
    completeQueueItem(item.id);
    sendResponse({ success: false, error: err.message });
  }
}

// Gerenciador dedicado para downloads do YouTube
async function handleYouTubeDownload(item, sendResponse) {
  try {
    let videoId = item.videoId;
    if (!videoId && item.url) {
      videoId = extractYouTubeId(item.url);
    }

    activeDownloads.set(item.id, {
      item: item,
      isHls: false,
      percent: 20,
      statusText: 'Obtendo stream do YouTube...'
    });

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      id: item.id,
      percent: 20,
      statusText: 'Obtendo stream do YouTube...'
    }).catch(() => {});

    let directStreamUrl = null;

    if (videoId) {
      try {
        const itRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Android; Mobile; rv:109.0) Gecko/115.0 Firefox/115.0'
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'ANDROID_VR',
                clientVersion: '1.60.19',
                deviceMake: 'Oculus',
                deviceModel: 'Quest 3',
                osName: 'Android',
                osVersion: '12'
              }
            },
            videoId: videoId
          })
        });

        if (itRes.ok) {
          const data = await itRes.json();
          if (data && data.streamingData) {
            // Formatos combinados (áudio e vídeo multiplexados)
            const combined = (data.streamingData.formats || []).filter(f => f.url && f.mimeType && f.mimeType.includes('mp4'));
            if (combined.length > 0) {
              combined.sort((a, b) => (b.height || 0) - (a.height || 0));
              directStreamUrl = combined[0].url;
            }
          }
        }
      } catch (err) {
        console.warn('InnerTube fetch error:', err);
      }
    }

    if (directStreamUrl) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        id: item.id,
        percent: 50,
        statusText: 'Baixando vídeo...'
      }).catch(() => {});

      const store = await chrome.storage.local.get(['settings', 'history']);
      const settings = store.settings || DEFAULT_SETTINGS;
      const safeTitle = cleanTitle(item.title);
      const filename = `${safeTitle}.mp4`;
      const targetFilePath = getDownloadFilePath(item, filename, settings);

      chrome.downloads.download({
        url: directStreamUrl,
        filename: targetFilePath,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        activeDownloads.delete(item.id);

        if (chrome.runtime.lastError) {
          console.warn('Erro chrome.downloads direto, usando helper:', chrome.runtime.lastError);
          openYouTubeDownloadHelper(item, videoId, sendResponse);
          return;
        }

        markItemAsDownloadedInTabs(item);
        saveDownloadToHistory(downloadId, item, 'MP4 (YouTube)');

        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          id: item.id,
          percent: 100,
          statusText: 'Download Concluído!'
        }).catch(() => {});

        completeQueueItem(item.id);
        if (sendResponse) sendResponse({ success: true, downloadId });
      });
      return;
    }

    // Se o stream direto não estiver disponível (proteção anti-bot do YouTube), abre helper instantâneo
    openYouTubeDownloadHelper(item, videoId, sendResponse);
  } catch (err) {
    console.error('Erro em handleYouTubeDownload:', err);
    activeDownloads.delete(item.id);
    completeQueueItem(item.id);
    if (sendResponse) sendResponse({ success: false, error: err.message });
  }
}

function openYouTubeDownloadHelper(item, videoId, sendResponse) {
  const vId = videoId || (item.url ? extractYouTubeId(item.url) : '');
  const helperUrl = vId ? `https://ssyoutube.com/watch?v=${vId}` : `https://ssyoutube.com/`;

  chrome.tabs.create({ url: helperUrl, active: true }, () => {
    activeDownloads.delete(item.id);

    markItemAsDownloadedInTabs(item);
    saveDownloadToHistory(Date.now(), item, 'MP4 (YouTube)');

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      id: item.id,
      percent: 100,
      statusText: 'Aba de download aberta!'
    }).catch(() => {});

    completeQueueItem(item.id);
    if (sendResponse) sendResponse({ success: true, mode: 'helper_opened' });
  });
}

function extractYouTubeId(url) {
  if (!url) return '';
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|watch\?.+&v=))([\w-]{11})/i);
  return match ? match[1] : '';
}
