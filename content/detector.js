// Video Download Unlimited - Content Media Detector
// Detecta mídias no DOM, extrai miniaturas reais (posters/canvas snapshot) de qualquer site e relata ao Background

(() => {
  const detectedMedia = new Map();
  const reportedThumbnails = new Set();

  function getPageMetadata() {
    const title = document.title || 'Vídeo';
    let thumbnail = '';

    const ogImage = document.querySelector('meta[property="og:image"]')?.content ||
                    document.querySelector('meta[name="twitter:image"]')?.content ||
                    document.querySelector('link[rel="image_src"]')?.href;
    if (ogImage) {
      thumbnail = ogImage;
    }

    return { title, thumbnail, url: window.location.href };
  }

  // Tenta extrair a miniatura real do elemento de vídeo em qualquer site
  function extractVideoPoster(vid) {
    if (vid.poster) return vid.poster;

    const attrPoster = vid.getAttribute('poster') ||
                       vid.getAttribute('data-poster') ||
                       vid.getAttribute('data-thumb');
    if (attrPoster) return attrPoster;

    // Busca imagens de thumbnail dentro do mesmo card/player do vídeo
    const container = vid.closest('.video-container, .player, .media, article, .post, [class*="player"], [class*="video"], [class*="card"]') || vid.parentElement;
    if (container) {
      const img = container.querySelector('img[src*="thumb"], img[src*="preview"], img[src*="poster"], img[src*="cover"], img');
      if (img && img.src && !img.src.startsWith('data:image/svg') && img.naturalWidth > 40) {
        return img.src;
      }
    }

    // Snapshot via Canvas se o vídeo já carregou quadros
    if (vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = Math.round(160 * (vid.videoHeight / vid.videoWidth));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        if (dataUrl && dataUrl.length > 200) {
          return dataUrl;
        }
      } catch (e) {
        // Ignora caso o canvas seja restrito por CORS em vídeo cross-origin
      }
    }

    return null;
  }

  function reportMedia(item) {
    if (!item.url || item.url.startsWith('blob:') || item.url.startsWith('data:')) {
      return;
    }

    if (detectedMedia.has(item.url)) return;
    detectedMedia.set(item.url, item);

    chrome.runtime.sendMessage({
      type: 'MEDIA_DETECTED',
      payload: item
    }).catch(() => {});
  }

  // Detecção dedicada para vídeos do YouTube (watch, shorts, youtu.be)
  function checkYouTubeVideo() {
    const host = window.location.hostname;
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return;

    let videoId = null;
    try {
      const vParam = new URLSearchParams(window.location.search).get('v');
      if (vParam) {
        videoId = vParam;
      } else if (window.location.pathname.startsWith('/shorts/')) {
        const parts = window.location.pathname.split('/shorts/')[1];
        videoId = parts ? parts.split('/')[0].split('?')[0] : null;
      } else if (host.includes('youtu.be')) {
        const parts = window.location.pathname.replace(/^\//, '');
        videoId = parts.split('/')[0].split('?')[0];
      }
    } catch (e) {}

    if (!videoId) return;

    // Extrai título amigável e limpo
    let title = document.title || 'YouTube Video';
    title = title.replace(/\s*-\s*YouTube$/i, '').trim();

    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, h1.title, #container h1');
    if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
      title = titleEl.textContent.trim();
    }

    const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const ytItem = {
      id: `yt_${videoId}`,
      videoId: videoId,
      url: canonicalUrl,
      title: title,
      thumbnail: thumbUrl,
      quality: 'HD',
      format: 'MP4',
      type: 'youtube',
      source: 'youtube',
      pageUrl: window.location.href,
      timestamp: Date.now()
    };

    if (detectedMedia.has(ytItem.url)) {
      const existing = detectedMedia.get(ytItem.url);
      if (title && title !== 'YouTube Video' && existing.title !== title) {
        existing.title = title;
        chrome.runtime.sendMessage({
          type: 'MEDIA_DETECTED',
          payload: existing
        }).catch(() => {});
      }
      return;
    }

    reportMedia(ytItem);
  }

  function scanMediaElements() {
    checkYouTubeVideo();
    const pageMeta = getPageMetadata();
    const videos = document.querySelectorAll('video');

    videos.forEach((vid, index) => {
      const poster = extractVideoPoster(vid) || pageMeta.thumbnail;
      let src = vid.currentSrc || vid.src;
      const height = vid.videoHeight || 0;
      const quality = height ? `${height}p` : 'HD';

      // Se encontrou uma miniatura para o vídeo (mesmo que seja blob de streaming),
      // envia ao background para vincular ao fluxo da aba
      if (poster && !reportedThumbnails.has(poster)) {
        reportedThumbnails.add(poster);
        chrome.runtime.sendMessage({
          type: 'THUMBNAIL_DISCOVERED',
          thumbnail: poster,
          index: index
        }).catch(() => {});
      }

      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        reportMedia({
          url: src,
          title: pageMeta.title,
          thumbnail: poster,
          quality: quality,
          format: getExtension(src) || 'MP4',
          type: 'video',
          pageUrl: window.location.href,
          timestamp: Date.now()
        });
      }

      // Procura tags <source> filhas
      const sources = vid.querySelectorAll('source');
      sources.forEach(s => {
        if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
          reportMedia({
            url: s.src,
            title: pageMeta.title,
            thumbnail: poster,
            quality: quality,
            format: getExtension(s.src) || (s.type ? s.type.split('/')[1] : 'MP4'),
            type: 'video',
            pageUrl: window.location.href,
            timestamp: Date.now()
          });
        }
      });
    });

    // Procura iframes de vídeos comuns
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((ifr, idx) => {
      const src = ifr.src || '';
      // Procura poster associado ao iframe
      const container = ifr.closest('article, .post, .card, [class*="video"]') || ifr.parentElement;
      if (container) {
        const img = container.querySelector('img[src*="preview"], img[src*="thumb"], img');
        if (img && img.src && !reportedThumbnails.has(img.src)) {
          reportedThumbnails.add(img.src);
          chrome.runtime.sendMessage({
            type: 'THUMBNAIL_DISCOVERED',
            thumbnail: img.src,
            index: videos.length + idx
          }).catch(() => {});
        }
      }
    });

    // Escaneia tags de áudio
    const audios = document.querySelectorAll('audio');
    audios.forEach(aud => {
      let src = aud.currentSrc || aud.src;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        reportMedia({
          url: src,
          title: pageMeta.title,
          thumbnail: pageMeta.thumbnail,
          quality: 'Áudio',
          format: getExtension(src) || 'MP3',
          type: 'audio',
          pageUrl: window.location.href,
          timestamp: Date.now()
        });
      }
    });
  }

  function getExtension(url) {
    try {
      const pathname = new URL(url).pathname;
      const ext = pathname.split('.').pop().toLowerCase();
      if (['mp4', 'webm', 'm4v', 'mkv', 'flv', 'mp3', 'm4a', 'aac', 'ogg', 'wav'].includes(ext)) {
        return ext.toUpperCase();
      }
    } catch {}
    return null;
  }

  // Executa imediatamente e no carregamento completo
  checkYouTubeVideo();
  scanMediaElements();
  window.addEventListener('load', () => {
    checkYouTubeVideo();
    scanMediaElements();
  });

  // Eventos específicos do player SPA do YouTube
  function handleYouTubeNav() {
    checkYouTubeVideo();
    setTimeout(checkYouTubeVideo, 500);
    setTimeout(checkYouTubeVideo, 1500);
  }
  window.addEventListener('yt-navigate-finish', handleYouTubeNav);
  document.addEventListener('yt-navigate-finish', handleYouTubeNav);
  window.addEventListener('popstate', handleYouTubeNav);

  // Monitora reprodução e carregamento de quadros
  document.addEventListener('play', scanMediaElements, true);
  document.addEventListener('loadeddata', scanMediaElements, true);
  document.addEventListener('timeupdate', () => {
    // Tenta capturar snapshot logo nos primeiros segundos de reprodução se ainda não houver poster
    scanMediaElements();
  }, { capture: true, once: true });

  // Observer para páginas dinâmicas (SPA, timelines infinitas, YouTube, etc.)
  const observer = new MutationObserver(() => {
    checkYouTubeVideo();
    scanMediaElements();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Responde a solicitações de scan do popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCAN_PAGE') {
      checkYouTubeVideo();
      scanMediaElements();
      sendResponse({ status: 'ok', count: detectedMedia.size });
    }
  });
})();
