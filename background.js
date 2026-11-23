const NOTIF_ICON_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mNkYPhfz0AEYBxVSF+FjAxkKmQkV+H/////00chAG3bC+kAAAAABJRU5ErkJggg==';

const IS_ANDROID_BROWSER = /Android/i.test(globalThis.navigator?.userAgent || '');

const DEFAULT_GEMINI_PROMPT = `We are going to play a game. I will provide you with an image, and you must analyze it.

IMAGE STRUCTURE:

- Top left: A box containing the REFERENCE IMAGE.
- Top right: A box containing the TEXT (instructions).
- Middle: The ORIGINAL SCENE to analyze, containing exactly 8 monsters. You must select 2 monsters according to the instructions in the top-right box and the reference image in the top-left box.
- Bottom: An identical copy of the original scene from the middle, overlaid with a grid of red lines.

The bottom grid contains exactly 23 columns and 14 rows. Each cell contains a small blue label in the format ColumnLetterRowNumber, for example A1, B1, or W14.

Use these blue labels directly to locate the center of each selected monster in the original scene. Do not calculate a virtual grid or guess the coordinates. The original scene and the gridded copy have exactly the same dimensions and alignment.

The columns are labeled from A to W (A = 1, W = 23), and the rows are numbered from 1 to 14 (1 at the top, 14 at the bottom).

Therefore, you must identify exactly 2 monsters.

STRICT RESPONSE FORMAT (no additional text, no Markdown, no explanations):
ColumnLetter;RowNumber
ColumnLetter;RowNumber

Example of a valid response:
C;5
W;14`;

function notify(id, title, message, priority = 0) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: NOTIF_ICON_DATAURL,
    title,
    message,
    priority,
    requireInteraction: false
  });
}

function notifyCaptureDone(count, title) {
  notify('capture-done', 'Capture archivée', `${count} image(s) téléchargée(s).\nTexte : ${title ?? '—'}`, 0);
}

function notifyCaptureError(reason) {
  notify('capture-error', 'Échec de capture', reason, 2);
}

function sendPageStatus(tabId, message, type = 'info') {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'captureStatus', message, statusType: type }, () => {
    if (chrome.runtime.lastError) {
      // Ignorer si l'onglet n'est plus actif ou récepteur
    }
  });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function cleanModelText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractAssistantText(value) {
  if (typeof value === 'string') return cleanModelText(value);
  if (!Array.isArray(value)) return '';
  return cleanModelText(value
    .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
    .map((part) => typeof part === 'string' ? part : part.text)
    .join('\n'));
}

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: `captures/${filename}`,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(`${filename}: ${error.message}`));
        else if (downloadId === undefined) reject(new Error(`${filename}: identifiant de téléchargement absent`));
        else resolve(downloadId);
      }
    );
  });
}

async function downloadBlob(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  return downloadDataUrl(dataUrl, filename);
}

function getLocalSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      geminiApiKey: '',
      geminiModel: 'gemini-3.5-flash-lite',
      aiProvider: 'gemini',
      deepseekApiKey: '',
      deepseekModel: 'deepseek-flash',
      geminiEnabled: true,
      extensionActive: true,
      downloadImages: true,
      useRenderServer: false,
      renderApiUrl: 'https://only-faucet.onrender.com',
      useLocalServer: false,
      localApiUrl: 'http://127.0.0.1:3000',
      processingTarget: 'mobile',
      duplicateScene: false,
      gridSceneScale: 1
    }, (values) => {
      resolve({
        geminiApiKey: String(values.geminiApiKey || '').trim(),
        geminiModel: String(values.geminiModel || 'gemini-3.5-flash-lite').trim(),
        aiProvider: values.aiProvider === 'deepseek' ? 'deepseek' : 'gemini',
        deepseekApiKey: String(values.deepseekApiKey || '').trim(),
        deepseekModel: String(values.deepseekModel || 'deepseek-flash').trim(),
        geminiEnabled: values.geminiEnabled,
        extensionActive: values.extensionActive,
        downloadImages: values.downloadImages,
        useRenderServer: values.useRenderServer,
        renderApiUrl: values.renderApiUrl,
        useLocalServer: values.useLocalServer,
        localApiUrl: values.localApiUrl,
        processingTarget: values.processingTarget === 'extension' ? 'extension' : 'mobile',
        duplicateScene: values.duplicateScene === true,
        gridSceneScale: [1, 1.25, 1.5, 2].includes(Number(values.gridSceneScale)) ? Number(values.gridSceneScale) : 1,
        geminiPrompt: DEFAULT_GEMINI_PROMPT
      });
    });
  });
}

function columnLetterToIndex(colStr) {
  let idx = 0;
  for (let i = 0; i < colStr.length; i++) {
    idx = idx * 26 + (colStr.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return idx - 1;
}

function parseGridCoordinates(rawText, imgWidth, imgHeight, cols = 23, rows = 14) {
  const coords = [];
  const colWidth = imgWidth / cols;
  const rowHeight = imgHeight / rows;

  if (!rawText) return coords;

  const lines = rawText.split('\n');
  for (let line of lines) {
    line = line.trim().toUpperCase().replace(/\s+/g, '');
    if (!line || !line.includes(';')) continue;

    const parts = line.split(';');
    if (parts.length !== 2) continue;

    const [colStr, rowStr] = parts;
    if (/^[A-Z]{1,2}$/.test(colStr)) {
      const colIdx = columnLetterToIndex(colStr);
      if (/^\d+$/.test(rowStr)) {
        const rowIdx = parseInt(rowStr, 10) - 1;
        if (colIdx >= 0 && colIdx < cols && rowIdx >= 0 && rowIdx < rows) {
          const x = Math.round((colIdx + 0.5) * colWidth);
          const y = Math.round((rowIdx + 0.5) * rowHeight);
          coords.push({ x, y });
        }
      }
    }
  }
  return coords;
}

async function processAnswerAndExecute(rawAnswer, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings) {
  let answer = rawAnswer.trim();
  answer = answer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

  const coords = parseGridCoordinates(answer, stageWidth, stageHeight, 23, 14);

  if (coords.length === 0) {
    throw new Error(`Aucune coordonnée valide trouvée : ${answer.slice(0, 50)}`);
  }

  if (settings.downloadImages) {
    const reportText = `Réponse brute :\n${answer}\n\nCoordonnées (Pixels) :\n${coords.map(c => `${c.x};${c.y}`).join('\n')}`;
    const report = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
    await downloadBlob(report, `capture-${timestamp}-gemini.txt`);
    notifyCaptureDone(1, 'Capture archivée');
  }

  const clickCoords = coords.map(c => ({
    x: stage.x + (c.x / stage.dpr),
    y: stage.y + (c.y / stage.dpr)
  }));

  chrome.tabs.sendMessage(tabId, {
    type: 'clickMonsters',
    coords: clickCoords
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[Auto Click] Connexion fermée lors du clic automatique :", chrome.runtime.lastError.message);
    }
  });

  notify('capture-gemini', 'Analyse terminée', 'Clic automatique en cours...');
  sendPageStatus(tabId, `Analyse terminée : ${coords.length} élément(s). Clic en cours...`, 'success');
}

const remoteConnections = new Map();
const pendingRemoteJobs = new Map();
const reconnectTimers = new Map();

function scheduleRemoteReconnect(serverUrl, serverName, delayMs = 3000) {
  const wsUrl = toWebSocketUrl(serverUrl);
  if (reconnectTimers.has(wsUrl) || remoteConnections.has(wsUrl)) return;

  const timer = setTimeout(() => {
    reconnectTimers.delete(wsUrl);
    if (remoteConnections.has(wsUrl)) return;

    getRemoteSocket(serverUrl, serverName).catch((error) => {
      console.warn(`[Auto Click] Reconnexion ${serverName} échouée :`, error.message);
      scheduleRemoteReconnect(serverUrl, serverName, Math.min(delayMs * 2, 30000));
    });
  }, delayMs);

  reconnectTimers.set(wsUrl, timer);
}

function toWebSocketUrl(serverUrl) {
  const cleanUrl = String(serverUrl || '').trim().replace(/\/$/, '');
  if (/^wss?:\/\//i.test(cleanUrl)) return cleanUrl;
  if (/^https:\/\//i.test(cleanUrl)) return cleanUrl.replace(/^https:/i, 'wss:');
  if (/^http:\/\//i.test(cleanUrl)) return cleanUrl.replace(/^http:/i, 'ws:');
  throw new Error(`URL serveur invalide : ${serverUrl}`);
}

function closeRemoteConnection(wsUrl, socket) {
  const entry = remoteConnections.get(wsUrl);
  if (entry?.socket === socket) remoteConnections.delete(wsUrl);
  const pending = pendingRemoteJobs.get(socket);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRemoteJobs.delete(socket);
    pending.reject(new Error('La connexion WebSocket Render a été fermée.'));
  }
}

function getRemoteSocket(serverUrl, serverName) {
  const wsUrl = toWebSocketUrl(serverUrl);
  const existing = remoteConnections.get(wsUrl);
  if (existing?.socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(existing.socket);
  }
  if (existing?.readyPromise) return existing.readyPromise;

  const socket = new WebSocket(wsUrl);
  const entry = { socket, readyPromise: null, pingTimer: null };
  remoteConnections.set(wsUrl, entry);

  entry.readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        remoteConnections.delete(wsUrl);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: 'register_extension' }));
        entry.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20000);
        settled = true;
        resolve(socket);
      } catch (error) {
        fail(error);
      }
    };

    socket.onerror = () => {
      fail(new Error(`Connexion WebSocket impossible au serveur ${serverName}.`));
    };

    socket.onclose = () => {
      clearInterval(entry.pingTimer);
      closeRemoteConnection(wsUrl, socket);
      if (!settled) fail(new Error(`Connexion WebSocket fermée par ${serverName}.`));
      scheduleRemoteReconnect(serverUrl, serverName);
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        console.warn('[Auto Click] Message WebSocket non JSON ignoré.');
        return;
      }

      if (data.type === 'pong' || data.type === 'registered') return;

      if (data.type === 'reload_page') {
        const reloadTabId = Number(data.tabId);
        if (!Number.isInteger(reloadTabId)) return;

        chrome.tabs.reload(reloadTabId, {}, () => {
          const reloadError = chrome.runtime.lastError;
          if (reloadError) {
            console.warn('[Auto Click] Rechargement impossible :', reloadError.message);
            return;
          }
          sendPageStatus(reloadTabId, 'Page rechargée après suppression de la tâche.', 'info');
        });
        return;
      }

      const pending = pendingRemoteJobs.get(socket);
      if (!pending) return;

      if (data.type === 'job_accepted') {
        pending.jobId = data.id;
        const target = data.processingTarget || pending.processingTarget || 'mobile';
        const targetLabel = target === 'extension' ? 'extension Gemini / Claude' : 'mobile';
        sendPageStatus(pending.tabId, `Serveur ${serverName} a reçu la tâche (${data.id}). Traitement par ${targetLabel}…`, 'loading');
        notify('task-accepted', 'Tâche reçue par le serveur', `Traitement par ${targetLabel}.`, 0);
        return;
      }

      if (data.type === 'job_result' && (!pending.jobId || data.id === pending.jobId)) {
        clearTimeout(pending.timer);
        pendingRemoteJobs.delete(socket);
        pending.resolve(data.response || '');
        return;
      }

      if (data.type === 'job_expired') {
        clearTimeout(pending.timer);
        pendingRemoteJobs.delete(socket);
        pending.reject(new Error(data.error || 'La tâche a expiré après 2 minutes.'));
        return;
      }

      if (data.type === 'job_cancelled') {
        clearTimeout(pending.timer);
        pendingRemoteJobs.delete(socket);
        pending.reject(new Error('La tâche Render a été supprimée.'));
        return;
      }

      if (data.type === 'error') {
        clearTimeout(pending.timer);
        pendingRemoteJobs.delete(socket);
        pending.reject(new Error(data.error || `Erreur du serveur ${serverName}.`));
      }
    };
  });

  return entry.readyPromise;
}

function sendAnalyzeAndWait(socket, payload, tabId, serverName, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    if (pendingRemoteJobs.has(socket)) {
      reject(new Error(`Une analyse ${serverName} est déjà en cours.`));
      return;
    }

    const pending = {
      jobId: null,
      tabId,
      processingTarget: payload.processingTarget,
      resolve,
      reject,
      timer: setTimeout(() => {
        pendingRemoteJobs.delete(socket);
        reject(new Error(`Délai dépassé pour le serveur ${serverName}.`));
      }, timeoutMs)
    };

    pendingRemoteJobs.set(socket, pending);
    try {
      socket.send(JSON.stringify({
        type: 'analyze_image',
        prompt: payload.prompt,
        imageDataUrl: payload.imageDataUrl,
        tabId,
        processingTarget: payload.processingTarget
      }));
    } catch (error) {
      clearTimeout(pending.timer);
      pendingRemoteJobs.delete(socket);
      reject(error);
    }
  });
}

async function analyzeWithRemoteServer(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings, serverUrl, serverName) {
  sendPageStatus(tabId, `Connexion au serveur ${serverName}…`, 'loading');

  const dataUrl = await blobToDataUrl(blob);
  const socket = await getRemoteSocket(serverUrl, serverName);
  sendPageStatus(tabId, `Envoi de l’image au serveur ${serverName}…`, 'loading');

  const answer = cleanModelText(await sendAnalyzeAndWait(
    socket,
    { prompt: settings.geminiPrompt, imageDataUrl: dataUrl, processingTarget: settings.processingTarget },
    tabId,
    serverName
  ));

  if (!answer) {
    throw new Error(`Réponse vide du serveur ${serverName} après traitement.`);
  }

  await processAnswerAndExecute(answer, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings);
}

async function analyzeWithDirectGemini(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings) {
  if (!settings.geminiApiKey) {
    throw new Error('Clé API Gemini non configurée. Enregistrez-la dans le popup.');
  }

  sendPageStatus(tabId, 'Envoi de l’image à Gemini…', 'loading');
  const dataUrl = await blobToDataUrl(blob);
  const separator = dataUrl.indexOf(',');
  const base64Data = separator >= 0 ? dataUrl.slice(separator + 1) : dataUrl;
  const mimeType = dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/png';
  const model = encodeURIComponent(settings.geminiModel || 'gemini-3.5-flash-lite');

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Tu es un assistant de vision. Réponds uniquement avec les coordonnées demandées, au format demandé, sans texte supplémentaire.' }]
        },
        contents: [{
          role: 'user',
          parts: [
            { text: settings.geminiPrompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 500 }
      })
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.error?.message || `API Gemini HTTP ${response.status}`);
  }
  const answer = cleanModelText(result?.candidates?.[0]?.content?.parts?.[0]?.text);
  if (!answer) throw new Error('Réponse Gemini vide.');
  await processAnswerAndExecute(answer, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings);
}

async function analyzeWithDirectDeepSeek(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings) {
  if (!settings.deepseekApiKey) {
    throw new Error('Clé API DeepSeek non configurée. Enregistrez-la dans le popup.');
  }

  sendPageStatus(tabId, 'Envoi de l’image à DeepSeek…', 'loading');
  const dataUrl = await blobToDataUrl(blob);
  const model = settings.deepseekModel || 'deepseek-flash';
  const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.deepseekApiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: settings.geminiPrompt },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'original' } }
        ]
      }],
      temperature: 0,
      max_tokens: 500,
      thinking: { type: 'disabled' }
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.error?.message || `API DeepSeek HTTP ${response.status}`);
  }
  const message = result?.choices?.[0]?.message;
  const answer = extractAssistantText(message?.content)
    || extractAssistantText(result?.output_text)
    || extractAssistantText(message?.reasoning_content);
  if (!answer) {
    const finishReason = result?.choices?.[0]?.finish_reason;
    const detail = finishReason ? ` (finish_reason: ${finishReason})` : '';
    throw new Error(`Réponse DeepSeek vide${detail}. Utilisez le modèle deepseek-flash compatible vision.`);
  }
  await processAnswerAndExecute(answer, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings);
}

async function analyzeCompositeWithGemini(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight) {
  const settings = await getLocalSettings();
  if (!settings.extensionActive) return;
  if (!settings.geminiEnabled) return;

  try {
    if (settings.useLocalServer) {
      await analyzeWithRemoteServer(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings, settings.localApiUrl, 'Local');
    } else if (settings.useRenderServer) {
      await analyzeWithRemoteServer(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings, settings.renderApiUrl, 'Render');
    } else if (settings.aiProvider === 'deepseek') {
      await analyzeWithDirectDeepSeek(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings);
    } else {
      await analyzeWithDirectGemini(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight, settings);
    }
  } catch (analysisError) {
    console.error('[Auto Click] Erreur d’analyse :', analysisError);
    notifyCaptureError(`Analyse échouée : ${analysisError.message}`);
    sendPageStatus(tabId, `Erreur d'analyse : ${analysisError.message}`, 'error');
  }
}

function drawPromptText(ctx, title, subtitle, x, width, headerHeight) {
  const padding = 14;
  const maxWidth = Math.max(80, width - padding * 2);
  let y = 28;

  ctx.fillStyle = '#000000';
  ctx.fillRect(x, 0, width, headerHeight);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 18px Arial, sans-serif';

  const drawLines = (text, lineHeight) => {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        ctx.fillText(line, x + padding, y);
        y += lineHeight;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      ctx.fillText(line, x + padding, y);
      y += lineHeight;
    }
  };

  drawLines(title || '(aucun titre)', 23);
  if (subtitle) {
    y += 6;
    ctx.fillStyle = '#d1d5db';
    ctx.font = '400 14px Arial, sans-serif';
    drawLines(subtitle, 19);
  }
}

async function dispatchTrustedClick(tabId, point) {
  const target = { tabId };
  let attached = false;
  const debuggerApi = globalThis.chrome?.debugger ?? globalThis.browser?.debugger;

  if (!debuggerApi?.attach || !debuggerApi?.sendCommand) {
    return { ok: false, trustedInput: false, error: 'API debugger indisponible.' };
  }

  try {
    await debuggerApi.attach(target, '1.3');
    attached = true;

    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });

    return { ok: true, trustedInput: true, point };
  } catch (error) {
    return {
      ok: false,
      trustedInput: false,
      error: error.message
    };
  } finally {
    if (attached) {
      try { await debuggerApi.detach(target); } catch (_) {}
    }
  }
}

function captureVisibleTabWithFallback(tabId, callback) {
  if (tabId == null) {
    callback(null, 'Identifiant d’onglet absent.');
    return;
  }

  const target = { tabId };

  chrome.debugger.attach(target, '1.3', () => {
    const attachError = chrome.runtime.lastError;
    if (attachError) {
      callback(null, `Débogueur Kiwi impossible à attacher : ${attachError.message}`);
      return;
    }

    chrome.debugger.sendCommand(
      target,
      'Page.captureScreenshot',
      { format: 'png' },
      (result) => {
        const captureError = chrome.runtime.lastError;
        const dataUrl = !captureError && result?.data
          ? `data:image/png;base64,${result.data}`
          : null;
        const errorMessage = captureError?.message || (!result?.data ? 'Image PNG absente.' : null);

        chrome.debugger.detach(target, () => {
          void chrome.runtime.lastError;
          callback(dataUrl, errorMessage);
        });
      }
    );
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'trustedClick') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'Onglet source introuvable.' });
      return;
    }
    dispatchTrustedClick(tabId, msg.point).then(sendResponse);
    return true;
  }

  if (msg.type === 'captureError') {
    notifyCaptureError(msg.reason);
    return;
  }

  if (msg.type !== 'captureCards') return;

  const tabId = sender.tab.id;

  chrome.tabs.update(tabId, { active: true }, () => {
    const updateError = chrome.runtime.lastError;
    if (updateError) {
      console.warn('[Auto Click] Fenêtre non focalisée :', updateError.message);
    }

    chrome.tabs.get(tabId, () => {
      setTimeout(() => {
        captureVisibleTabWithFallback(tabId, async (dataUrl, captureError) => {
          if (captureError || !dataUrl) {
            const reason = `Capture échouée : ${captureError || 'image introuvable'}`;
            notifyCaptureError(reason);
            sendPageStatus(tabId, reason, 'error');
            return;
          }

          try {
            const blob = await fetch(dataUrl).then((r) => r.blob());
            const bitmap = await createImageBitmap(blob);
            const settings = await getLocalSettings();
            const timestamp = msg.timestamp ?? Date.now();
            const ref = msg.rects.ref;
            const stage = msg.rects.stage;
            if (!ref || !stage) throw new Error('Zones introuvables.');

            const refWidth = Math.round(ref.width * ref.dpr);
            const refHeight = Math.round(ref.height * ref.dpr);
            const stageWidth = Math.round(stage.width * stage.dpr);
            const stageHeight = Math.round(stage.height * stage.dpr);

            if (refWidth <= 0 || refHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
              throw new Error('Dimensions invalides.');
            }

            const gridScale = settings.gridSceneScale;
            const gridWidth = Math.round(stageWidth * gridScale);
            const gridHeight = Math.round(stageHeight * gridScale);
            const compositeWidth = gridWidth;
            const refDrawWidth = Math.min(Math.round(refWidth * gridScale), compositeWidth);
            const refDrawHeight = Math.round(refHeight * (refDrawWidth / refWidth));
            const headerHeight = Math.max(refDrawHeight, 120);

            const compositeHeight = headerHeight + gridHeight * (settings.duplicateScene ? 2 : 1);
            const composite = new OffscreenCanvas(compositeWidth, compositeHeight);
            const compositeCtx = composite.getContext('2d');

            compositeCtx.fillStyle = '#000000';
            compositeCtx.fillRect(0, 0, compositeWidth, compositeHeight);

            drawPromptText(compositeCtx, msg.title, msg.subtitle, refDrawWidth, compositeWidth - refDrawWidth, headerHeight);

            compositeCtx.filter = 'grayscale(100%)';
            compositeCtx.drawImage(
              bitmap,
              Math.round(ref.x * ref.dpr), Math.round(ref.y * ref.dpr), refWidth, refHeight,
              0, 0, refDrawWidth, refDrawHeight
            );

            compositeCtx.drawImage(
              bitmap,
              Math.round(stage.x * stage.dpr), Math.round(stage.y * stage.dpr), stageWidth, stageHeight,
              0, headerHeight, gridWidth, gridHeight
            );
            compositeCtx.filter = 'none';

            if (settings.duplicateScene) {
              const gridY = headerHeight + gridHeight;
              compositeCtx.filter = 'grayscale(100%)';
              compositeCtx.drawImage(
                bitmap,
                Math.round(stage.x * stage.dpr), Math.round(stage.y * stage.dpr), stageWidth, stageHeight,
                0, gridY, gridWidth, gridHeight
              );
              compositeCtx.filter = 'none';

              // Grille 23 colonnes × 14 rangées, conservée en rouge.
              compositeCtx.strokeStyle = '#ff0000';
              compositeCtx.lineWidth = 1;
              compositeCtx.beginPath();
              for (let col = 1; col < 23; col++) {
                const x = Math.round((col * gridWidth) / 23) + 0.5;
                compositeCtx.moveTo(x, gridY);
                compositeCtx.lineTo(x, gridY + gridHeight);
              }
              for (let row = 1; row < 14; row++) {
                const y = Math.round(gridY + (row * gridHeight) / 14) + 0.5;
                compositeCtx.moveTo(0, y);
                compositeCtx.lineTo(gridWidth, y);
              }
              compositeCtx.stroke();

              compositeCtx.fillStyle = '#0066FF';
              compositeCtx.shadowColor = '#000000';
              compositeCtx.shadowBlur = 1;
              compositeCtx.font = 'bold 10px Arial, sans-serif';
              compositeCtx.textAlign = 'left';
              compositeCtx.textBaseline = 'top';
              const cellWidth = gridWidth / 23;
              const cellHeight = gridHeight / 14;
              for (let row = 0; row < 14; row++) {
                for (let col = 0; col < 23; col++) {
                  const columnLabel = String.fromCharCode('A'.charCodeAt(0) + col);
                  const x = Math.round(col * cellWidth) + 3;
                  const y = Math.round(gridY + row * cellHeight) + 2;
                  compositeCtx.fillText(`${columnLabel}${row + 1}`, x, y);
                }
              }
              compositeCtx.shadowColor = 'transparent';
              compositeCtx.shadowBlur = 0;
            }

            const compositeBlob = await composite.convertToBlob({ type: 'image/png' });

            if (settings.downloadImages) {
              await downloadBlob(compositeBlob, `capture-${timestamp}-composite.png`);
            }

            await analyzeCompositeWithGemini(
              compositeBlob,
              timestamp,
              tabId,
              bitmap,
              stage,
              stageWidth,
              stageHeight
            );
          } catch (err) {
            console.error('[Auto Click] Erreur :', err);
            const reason = `Téléchargement impossible : ${err.message}`;
            notifyCaptureError(reason);
            sendPageStatus(tabId, reason, 'error');
          }
        });
      }, 150);
    });
  });
});
