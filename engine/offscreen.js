// Video Download Unlimited - Offscreen HLS Engine
// Responsável por baixar, descriptografar (AES-128), concatenar e empacotar segmentos HLS em arquivo MP4 final

const activeHlsJobs = new Map(); // itemId -> { controller, aborted }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') {
    if (msg.type === 'PROCESS_HLS_DOWNLOAD') {
      handleHlsDownload(msg.payload);
      sendResponse({ status: 'started' });
      return true;
    }
    if (msg.type === 'CANCEL_HLS_DOWNLOAD') {
      const job = activeHlsJobs.get(msg.itemId);
      if (job) {
        job.aborted = true;
        job.controller.abort();
        activeHlsJobs.delete(msg.itemId);
      }
      sendResponse({ status: 'cancelled' });
      return true;
    }
    if (msg.type === 'REVOKE_BLOB') {
      try {
        URL.revokeObjectURL(msg.blobUrl);
      } catch (e) {}
    }
  }
});

const keyCache = new Map();

// Requisições com retentativa inteligente e backoff exponencial para lidar com instabilidades na rede
async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 600) {
  let attempt = 0;
  while (attempt < maxRetries) {
    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) {
          throw new Error(`HTTP ${res.status}`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      if (options.signal && options.signal.aborted) throw err;
      if (err.name === 'AbortError') throw err;
      attempt++;
      if (attempt >= maxRetries) throw err;
      const delay = Math.round(initialDelay * Math.pow(1.8, attempt - 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getDecryptionKey(keyUrl) {
  if (keyCache.has(keyUrl)) {
    return keyCache.get(keyUrl);
  }
  const res = await fetchWithRetry(keyUrl, {}, 3, 500);
  const keyBytes = await res.arrayBuffer();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  keyCache.set(keyUrl, cryptoKey);
  return cryptoKey;
}

async function decryptSegmentData(encryptedBuffer, keyInfo, seqNum) {
  if (!keyInfo || keyInfo.method !== 'AES-128') {
    return encryptedBuffer;
  }

  const cryptoKey = await getDecryptionKey(keyInfo.uri);
  let iv = keyInfo.iv;

  if (!iv) {
    // IV padrão: número de sequência de 16 bytes em big-endian
    iv = new Uint8Array(16);
    let s = seqNum;
    for (let i = 15; i >= 12; i--) {
      iv[i] = s & 0xff;
      s = s >> 8;
    }
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv },
      cryptoKey,
      encryptedBuffer
    );
    return decrypted;
  } catch (err) {
    console.warn('Falha na descriptografia AES-CBC do segmento:', err);
    return encryptedBuffer;
  }
}

async function handleHlsDownload(item) {
  const itemId = item.id;
  const masterUrl = item.url;
  const safeTitle = cleanTitle(item.title);

  const controller = new AbortController();
  activeHlsJobs.set(itemId, { controller, aborted: false });

  function notifyProgress(percent, text) {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      id: itemId,
      percent: percent,
      statusText: text
    }).catch(() => {});
  }

  try {
    notifyProgress(5, 'Lendo lista HLS...');
    const masterRes = await fetchWithRetry(masterUrl, { signal: controller.signal }, 3, 700);
    const masterText = await masterRes.text();

    let mediaPlaylistUrl = masterUrl;

    // 1. Verifica se é Master Playlist e seleciona a melhor resolução disponível
    if (masterText.includes('#EXT-X-STREAM-INF')) {
      const variants = parseMasterPlaylist(masterText, masterUrl);
      if (variants.length > 0) {
        mediaPlaylistUrl = variants[0].uri;
        notifyProgress(10, `Qualidade: ${variants[0].resolution}`);
      }
    }

    // 2. Obtém a Playlist de Mídia com os segmentos
    notifyProgress(15, 'Carregando partes do vídeo...');
    const mediaRes = await fetchWithRetry(mediaPlaylistUrl, { signal: controller.signal }, 3, 700);
    const mediaText = await mediaRes.text();

    // 3. Extrai todos os segmentos e informações de criptografia
    const segments = parseMediaPlaylist(mediaText, mediaPlaylistUrl);
    if (segments.length === 0) {
      throw new Error('Nenhum segmento de vídeo encontrado na playlist.');
    }

    notifyProgress(20, `0/${segments.length} partes`);

    // 4. Baixa e descriptografa todos os segmentos com concorrência controlada (4 paralelas)
    const segmentBuffers = new Array(segments.length);
    let downloadedCount = 0;
    const concurrency = 4;
    let nextIndex = 0;

    async function downloadWorker() {
      while (nextIndex < segments.length) {
        const job = activeHlsJobs.get(itemId);
        if (!job || job.aborted || controller.signal.aborted) {
          return;
        }

        const idx = nextIndex++;
        const seg = segments[idx];

        try {
          const res = await fetchWithRetry(seg.url, { signal: controller.signal }, 3, 500);
          const rawBuf = await res.arrayBuffer();

          // Descriptografa se necessário
          let finalBuf = rawBuf;
          if (seg.keyInfo) {
            finalBuf = await decryptSegmentData(rawBuf, seg.keyInfo, seg.seq);
          }

          segmentBuffers[idx] = finalBuf;
          downloadedCount++;
          const pct = Math.round(20 + (downloadedCount / segments.length) * 70);
          notifyProgress(pct, `${downloadedCount}/${segments.length} partes (${pct}%)`);
        } catch (e) {
          if (controller.signal.aborted || e.name === 'AbortError') return;
          console.error(`Falha no segmento ${idx} após tentativas:`, e);
          segmentBuffers[idx] = new ArrayBuffer(0);
        }
      }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(downloadWorker());
    }
    await Promise.all(workers);

    if (controller.signal.aborted) {
      activeHlsJobs.delete(itemId);
      notifyProgress(-2, 'Download cancelado');
      return;
    }

    // 5. Montagem do Arquivo MP4 Final
    notifyProgress(95, 'Montando arquivo MP4 final...');
    const finalBlob = new Blob(segmentBuffers, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(finalBlob);
    const filename = `${safeTitle}.mp4`;

    // 6. Envia o blobUrl para o Background Service Worker para acionar o chrome.downloads
    notifyProgress(98, 'Salvando arquivo no computador...');
    chrome.runtime.sendMessage({
      type: 'TRIGGER_FINAL_DOWNLOAD',
      blobUrl: blobUrl,
      filename: filename,
      item: item
    });

    activeHlsJobs.delete(itemId);

  } catch (err) {
    activeHlsJobs.delete(itemId);
    if (controller.signal.aborted || err.name === 'AbortError') {
      notifyProgress(-2, 'Download cancelado');
      return;
    }
    console.error('Erro no download HLS:', err);
    notifyProgress(-1, `Erro: ${err.message}`);
  }
}

// Analisa a Master Playlist e retorna variantes ordenadas por melhor qualidade
function parseMasterPlaylist(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];
  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      currentInfo = {
        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
        resolution: resMatch ? resMatch[1] : 'HD'
      };
    } else if (currentInfo && !line.startsWith('#')) {
      const uri = new URL(line, baseUrl).href;
      variants.push({ ...currentInfo, uri });
      currentInfo = null;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

// Analisa a Playlist de Mídia e retorna a lista ordenada de segmentos com suas chaves
function parseMediaPlaylist(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  let currentKey = null;
  let mediaSeq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([^,\s]+)/);
      const uriMatch = line.match(/URI=["']?([^"',\s]+)["']?/);
      const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);

      if (methodMatch && methodMatch[1] === 'AES-128' && uriMatch) {
        let iv = null;
        if (ivMatch) {
          const hex = ivMatch[1].slice(2).padStart(32, '0');
          iv = new Uint8Array(16);
          for (let b = 0; b < 16; b++) {
            iv[b] = parseInt(hex.substr(b * 2, 2), 16);
          }
        }
        currentKey = {
          method: 'AES-128',
          uri: new URL(uriMatch[1], baseUrl).href,
          iv: iv
        };
      } else if (methodMatch && methodMatch[1] === 'NONE') {
        currentKey = null;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI=["']?([^"']+)["']?/);
      if (uriMatch) {
        segments.push({
          url: new URL(uriMatch[1], baseUrl).href,
          isMap: true,
          keyInfo: null, // Segmento de inicialização padrão fMP4 (ftyp/moov)
          seq: 0
        });
      }
    } else if (!line.startsWith('#')) {
      try {
        const segUrl = new URL(line, baseUrl).href;
        segments.push({
          url: segUrl,
          isMap: false,
          keyInfo: currentKey ? { ...currentKey } : null,
          seq: mediaSeq++
        });
      } catch (e) {
        console.warn('URL de segmento inválida:', line);
      }
    }
  }

  return segments;
}

function cleanTitle(raw) {
  if (!raw) return 'Video_Download';
  return raw
    .replace(/\|/g, '-')
    .replace(/[\\/:*?"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Video_Download';
}
