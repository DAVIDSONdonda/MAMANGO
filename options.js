const defaults = {
  selector: 'span.mc-box',
  enabled: true,
  delayMs: 50,
  oncePerElement: true
};

const selector = document.querySelector('#selector');
const delayMs = document.querySelector('#delayMs');
const claimDelayMs = document.querySelector('#claimDelayMs');
const enabled = document.querySelector('#enabled');
const oncePerElement = document.querySelector('#oncePerElement');
const geminiEnabled = document.querySelector('#geminiEnabled');
const geminiApiKey = document.querySelector('#geminiApiKey');
const status = document.querySelector('#status');

chrome.storage.sync.get(defaults, (values) => {
  selector.value = values.selector;
  delayMs.value = values.delayMs;
  enabled.checked = values.enabled;
  oncePerElement.checked = values.oncePerElement;
});

chrome.storage.local.get({
  geminiEnabled: true,
  geminiApiKey: '',
  claimDelayMs: 1000
}, (values) => {
  geminiEnabled.checked = values.geminiEnabled;
  geminiApiKey.value = values.geminiApiKey;
  claimDelayMs.value = values.claimDelayMs;
});

document.querySelector('#save').addEventListener('click', () => {
  const value = selector.value.trim();
  if (!value) {
    status.textContent = 'Le sélecteur est obligatoire.';
    status.style.color = '#a11';
    return;
  }

  try {
    document.createDocumentFragment().querySelector(value);
  } catch {
    status.textContent = 'Sélecteur CSS invalide.';
    status.style.color = '#a11';
    return;
  }

  chrome.storage.sync.set({
    selector: value,
    delayMs: Math.max(0, Number(delayMs.value) || 0),
    enabled: enabled.checked,
    oncePerElement: oncePerElement.checked
  }, () => {
    chrome.storage.local.set({
      geminiEnabled: geminiEnabled.checked,
      geminiApiKey: geminiApiKey.value.trim(),
      claimDelayMs: Math.max(0, Math.min(60000, Number(claimDelayMs.value) || 0))
    }, () => {
      status.textContent = 'Options enregistrées.';
      status.style.color = '#176b35';
    });
  });
});
