const apiKey = document.querySelector('#apiKey');
const modelSelect = document.querySelector('#modelSelect');
const providerSelect = document.querySelector('#providerSelect');
const toggleProvider = document.querySelector('#toggleProvider');
const deepseekApiKey = document.querySelector('#deepseekApiKey');
const deepseekModelSelect = document.querySelector('#deepseekModelSelect');
const extensionActive = document.querySelector('#extensionActive');
const downloadImages = document.querySelector('#downloadImages');
const useRenderServer = document.querySelector('#useRenderServer');
const renderApiUrl = document.querySelector('#renderApiUrl');
const useLocalServer = document.querySelector('#useLocalServer');
const localApiUrl = document.querySelector('#localApiUrl');
const processingTarget = document.querySelector('#processingTarget');
const duplicateScene = document.querySelector('#duplicateScene');
const gridSceneScale = document.querySelector('#gridSceneScale');
const claimDelayMs = document.querySelector('#claimDelayMs');
const status = document.querySelector('#status');

function updateProviderToggleLabel() {
  toggleProvider.textContent = providerSelect.value === 'gemini'
    ? 'Basculer vers DeepSeek'
    : 'Basculer vers Gemini';
}

providerSelect.addEventListener('change', updateProviderToggleLabel);
toggleProvider.addEventListener('click', () => {
  providerSelect.value = providerSelect.value === 'gemini' ? 'deepseek' : 'gemini';
  updateProviderToggleLabel();
});

chrome.storage.local.get({
  geminiApiKey: '',
  geminiModel: 'gemini-3.5-flash-lite',
  aiProvider: 'gemini',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-flash',
  extensionActive: true,
  downloadImages: true,
  useRenderServer: false,
  renderApiUrl: 'https://only-faucet.onrender.com',
  useLocalServer: false,
  localApiUrl: 'http://127.0.0.1:3000',
  processingTarget: 'mobile',
  duplicateScene: false,
  gridSceneScale: 1,
  claimDelayMs: 1000
}, (values) => {
  apiKey.value = values.geminiApiKey;
  modelSelect.value = values.geminiModel;
  providerSelect.value = values.aiProvider;
  deepseekApiKey.value = values.deepseekApiKey;
  deepseekModelSelect.value = values.deepseekModel;
  extensionActive.checked = values.extensionActive;
  downloadImages.checked = values.downloadImages;
  useRenderServer.checked = values.useRenderServer;
  renderApiUrl.value = values.renderApiUrl;
  useLocalServer.checked = values.useLocalServer;
  localApiUrl.value = values.localApiUrl;
  processingTarget.value = values.processingTarget === 'extension' ? 'extension' : 'mobile';
  duplicateScene.checked = values.duplicateScene === true;
  gridSceneScale.value = ['1', '1.25', '1.5', '2'].includes(String(values.gridSceneScale)) ? String(values.gridSceneScale) : '1';
  claimDelayMs.value = Math.max(0, Math.min(60000, Number(values.claimDelayMs) || 0));
  updateProviderToggleLabel();
});

document.querySelector('#save').addEventListener('click', () => {
  const useRender = useRenderServer.checked;
  const useLocal = useLocalServer.checked;
  const key = apiKey.value.trim();
  const deepseekKey = deepseekApiKey.value.trim();

  if (!useRender && !useLocal && providerSelect.value === 'gemini' && !key) {
    status.textContent = 'Veuillez coller la clé API Gemini ou activer un serveur (Render / Local).';
    status.style.color = '#dc2626';
    return;
  }

  if (!useRender && !useLocal && providerSelect.value === 'deepseek' && !deepseekKey) {
    status.textContent = 'Veuillez coller la clé API DeepSeek ou activer un serveur (Render / Local).';
    status.style.color = '#dc2626';
    return;
  }

  chrome.storage.local.set({
    geminiApiKey: key,
    geminiModel: modelSelect.value,
    aiProvider: providerSelect.value,
    deepseekApiKey: deepseekKey,
    deepseekModel: deepseekModelSelect.value,
    extensionActive: extensionActive.checked,
    downloadImages: downloadImages.checked,
    useRenderServer: useRender,
    renderApiUrl: renderApiUrl.value.trim() || 'https://only-faucet.onrender.com',
    useLocalServer: useLocal,
    localApiUrl: localApiUrl.value.trim() || 'http://127.0.0.1:3000',
    processingTarget: processingTarget.value === 'extension' ? 'extension' : 'mobile',
    duplicateScene: duplicateScene.checked,
    gridSceneScale: Number(gridSceneScale.value),
    claimDelayMs: Math.max(0, Math.min(60000, Number(claimDelayMs.value) || 0))
  }, () => {
    if (chrome.runtime.lastError) {
      status.textContent = `Erreur : ${chrome.runtime.lastError.message}`;
      status.style.color = '#dc2626';
      return;
    }
    status.textContent = 'Configuration enregistrée avec succès !';
    status.style.color = '#059669';
  });
});
