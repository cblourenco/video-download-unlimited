// Video Download Unlimited - Options Script
document.addEventListener('DOMContentLoaded', async () => {
  const qualitySelect = document.getElementById('preferred-quality');
  const concurrentSelect = document.getElementById('max-concurrent');
  const patternInput = document.getElementById('filename-pattern');
  const subfolderSelect = document.getElementById('subfolder-mode');
  const notifCheckbox = document.getElementById('desktop-notifications');
  const themeSelect = document.getElementById('theme');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnReset = document.getElementById('btn-reset');
  const toast = document.getElementById('save-toast');

  const DEFAULT_SETTINGS = {
    maxConcurrent: 2,
    preferredQuality: 'highest',
    filenamePattern: '{title} [{quality}]',
    subfolderMode: 'site',
    desktopNotifications: true,
    theme: 'dark'
  };

  // Carrega configurações atuais
  const store = await chrome.storage.local.get('settings');
  const settings = store.settings || DEFAULT_SETTINGS;

  qualitySelect.value = settings.preferredQuality || 'highest';
  concurrentSelect.value = (settings.maxConcurrent || 2).toString();
  patternInput.value = settings.filenamePattern || '{title} [{quality}]';
  if (subfolderSelect) subfolderSelect.value = settings.subfolderMode || 'site';
  notifCheckbox.checked = settings.desktopNotifications !== false;
  themeSelect.value = settings.theme || 'dark';

  // Salva automaticamente ao alterar qualquer campo
  function autoSave() {
    const newSettings = {
      preferredQuality: qualitySelect.value,
      maxConcurrent: parseInt(concurrentSelect.value, 10),
      filenamePattern: patternInput.value.trim() || '{title}',
      subfolderMode: subfolderSelect ? subfolderSelect.value : 'site',
      desktopNotifications: notifCheckbox.checked,
      theme: themeSelect.value
    };

    chrome.storage.local.set({ settings: newSettings }, () => {
      showToast('Configurações salvas!');
    });
  }

  qualitySelect.addEventListener('change', autoSave);
  concurrentSelect.addEventListener('change', autoSave);
  patternInput.addEventListener('blur', autoSave);
  if (subfolderSelect) subfolderSelect.addEventListener('change', autoSave);
  notifCheckbox.addEventListener('change', autoSave);
  themeSelect.addEventListener('change', autoSave);

  // Limpar Histórico (executa diretamente sem solicitar confirmação)
  btnClearHistory.addEventListener('click', () => {
    chrome.storage.local.set({ history: [] }, () => {
      showToast('Histórico limpo com sucesso!');
      const oldText = btnClearHistory.textContent;
      btnClearHistory.textContent = '✓ Limpo!';
      setTimeout(() => {
        btnClearHistory.textContent = oldText;
      }, 1500);
    });
  });

  // Restaurar Padrões
  btnReset.addEventListener('click', () => {
    if (confirm('Deseja restaurar todas as configurações padrão?')) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => {
        qualitySelect.value = DEFAULT_SETTINGS.preferredQuality;
        concurrentSelect.value = DEFAULT_SETTINGS.maxConcurrent.toString();
        patternInput.value = DEFAULT_SETTINGS.filenamePattern;
        if (subfolderSelect) subfolderSelect.value = DEFAULT_SETTINGS.subfolderMode;
        notifCheckbox.checked = DEFAULT_SETTINGS.desktopNotifications;
        themeSelect.value = DEFAULT_SETTINGS.theme;
        showToast('Padrões restaurados!');
      });
    }
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2000);
  }
});
