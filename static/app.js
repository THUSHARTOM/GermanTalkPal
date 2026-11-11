import { createRecognizer } from './speech.js';
import { createTranslator, createLiveTranslation } from './translate.js';
import { createVoice } from './voice.js';

// Speak a little slower for the lower levels.
const SPEECH_RATE = { A1: 0.8, A2: 0.85, B1: 0.95, B2: 1, C1: 1 };

const LEVEL_NAMES = {
  A1: 'Beginner',
  A2: 'Elementary',
  B1: 'Intermediate',
  B2: 'Upper intermediate',
  C1: 'Advanced',
};
const DEFAULT_LEVEL = 'B1';

const $ = (id) => document.getElementById(id);
const el = {
  setup: $('setup'), chat: $('chat'), levels: $('levels'), start: $('start'),
  setupNote: $('setup-note'), levelBadge: $('level-badge'), stop: $('stop'),
  restart: $('restart'), banner: $('banner'), messages: $('messages'),
  live: $('live'), liveText: $('live-text'), liveTranslation: $('live-translation'),
  error: $('error'), errorText: $('error-text'), retry: $('retry'),
  controls: $('controls'), status: $('status'), talk: $('talk'), talkLabel: $('talk-label'),
  typeForm: $('type-form'), typeInput: $('type-input'),
  login: $('login'), loginForm: $('login-form'), loginPassword: $('login-password'),
  loginError: $('login-error'),
};

// phase: 'idle' (your turn) | 'listening' | 'thinking' (partner) | 'stopped'
const state = {
  level: DEFAULT_LEVEL,
  history: [],
  phase: 'stopped',
  session: 0, // bumped on Start and Stop so late async results are dropped
  request: null,
  thinkingRow: null,
  pendingLearnerRow: null, // the learner message still waiting for its correction
};

const voice = createVoice();

function speak(text) {
  voice.speak(text, { rate: SPEECH_RATE[state.level] || 1 });
}

// "ich habe gearbeitet." and "Ich habe gearbeitet" are the same answer.
function sameSentence(a, b) {
  const plain = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return plain(a) === plain(b);
}

// ---------- Backend ----------

async function postJson(path, body, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.signIn) showLogin(); // the session ended
  if (!response.ok) throw new Error(data.error || `The server returned an error (${response.status}).`);
  return data;
}

// ---------- Password ----------

function showLogin() {
  if (!el.chat.hidden && state.phase !== 'stopped') stopConversation();
  el.chat.hidden = true;
  el.setup.hidden = true;
  el.login.hidden = false;
  el.loginPassword.focus();
}

async function submitLogin(event) {
  event.preventDefault();
  el.loginError.hidden = true;
  try {
    await postJson('/api/login', { password: el.loginPassword.value });
    el.loginPassword.value = '';
    el.login.hidden = true;
    init();
  } catch (error) {
    el.loginError.textContent = error.message;
    el.loginError.hidden = false;
    el.loginPassword.select();
  }
}

const translator = createTranslator({
  serverTranslate: async (text, signal) => (await postJson('/api/translate', { text }, signal)).translation,
});

const liveTranslation = createLiveTranslation({
  translator,
  onResult: (translation) => { el.liveTranslation.textContent = translation; },
});

const recognizer = createRecognizer({
  onPartial: (text) => {
    if (state.phase !== 'listening') return;
    el.liveText.textContent = text;
    liveTranslation.update(text);
  },
});

// ---------- Rendering ----------

function addMessage(role, text, translation) {
  const item = document.createElement('li');
  item.className = `message ${role}`;
  const german = document.createElement('p');
  german.lang = 'de';
  german.textContent = text;
  const english = document.createElement('p');
  english.className = 'translation';
  english.textContent = translation || '';
  item.append(german, english);
  if (role === 'partner' && voice.supported) {
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'replay';
    replay.textContent = 'Hear again';
    replay.addEventListener('click', () => speak(text));
    item.append(replay);
  }
  el.messages.append(item);
  scrollToEnd();
  return item;
}

function addCorrection(row, correction) {
  const line = document.createElement('p');
  line.className = 'correction';
  const label = document.createElement('span');
  label.textContent = 'Better: ';
  const german = document.createElement('span');
  german.lang = 'de';
  german.textContent = correction;
  line.append(label, german);
  row.append(line);
  scrollToEnd();
}

function addSystemLine(text) {
  const item = document.createElement('li');
  item.className = 'system-line';
  item.textContent = text;
  el.messages.append(item);
  scrollToEnd();
}

function showThinking(show) {
  if (show && !state.thinkingRow) {
    const item = document.createElement('li');
    item.className = 'message partner thinking';
    item.setAttribute('aria-label', 'Your partner is thinking');
    item.innerHTML = '<span class="dots"><span>●</span> <span>●</span> <span>●</span></span>';
    el.messages.append(item);
    state.thinkingRow = item;
    scrollToEnd();
  } else if (!show && state.thinkingRow) {
    state.thinkingRow.remove();
    state.thinkingRow = null;
  }
}

function scrollToEnd() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function showError(message, canRetry) {
  el.errorText.textContent = message;
  el.retry.hidden = !canRetry;
  el.error.hidden = false;
}

function clearError() {
  el.error.hidden = true;
}

function setPhase(phase) {
  state.phase = phase;
  const yourTurn = phase === 'idle';
  const listening = phase === 'listening';

  el.talk.disabled = !(yourTurn || listening) || !recognizer.supported;
  el.talk.classList.toggle('active', listening);
  el.talkLabel.textContent = listening ? 'Release to send' : 'Hold to talk';
  el.typeInput.disabled = !yourTurn;
  el.typeForm.querySelector('button').disabled = !yourTurn;
  el.live.hidden = !listening;
  el.controls.hidden = phase === 'stopped';
  el.stop.hidden = phase === 'stopped';
  el.restart.hidden = phase !== 'stopped';

  if (listening) el.status.textContent = 'Listening…';
  else if (phase === 'thinking') el.status.textContent = 'Your partner is answering…';
  else if (yourTurn) {
    el.status.textContent = recognizer.supported
      ? 'Your turn: hold the button or the spacebar and speak German.'
      : 'This browser has no speech recognition. Type your German below, or use Chrome or Edge to speak.';
  } else el.status.textContent = '';
}

// ---------- Conversation loop ----------

function startConversation() {
  state.session++;
  state.history = [];
  el.messages.replaceChildren();
  state.thinkingRow = null;
  state.pendingLearnerRow = null;
  clearError();
  el.levelBadge.textContent = state.level;
  el.setup.hidden = true;
  el.chat.hidden = false;
  translator.prepare();
  voice.prepare();
  askPartner();
}

async function askPartner() {
  const session = state.session;
  clearError();
  setPhase('thinking');
  showThinking(true);
  state.request = new AbortController();
  try {
    const data = await postJson('/api/turn', { level: state.level, history: state.history }, state.request.signal);
    if (session !== state.session) return;
    showThinking(false);
    const learnerRow = state.pendingLearnerRow;
    state.pendingLearnerRow = null;
    if (learnerRow && data.correction && !sameSentence(data.correction, learnerRow.dataset.text)) {
      addCorrection(learnerRow, data.correction);
    }
    state.history.push({ role: 'partner', text: data.reply });
    addMessage('partner', data.reply, data.translation);
    setPhase('idle');
    speak(data.reply);
  } catch (error) {
    if (session !== state.session || error.name === 'AbortError') return;
    showThinking(false);
    showError(error.message || 'Could not reach the server.', true);
    setPhase('idle');
  }
}

function submitLearner(text) {
  const session = state.session;
  clearError();
  state.history.push({ role: 'learner', text });
  // Show what we have at once; replace it with the translation of the final text.
  voice.cancel();
  const row = addMessage('learner', text, el.liveTranslation.textContent);
  row.dataset.text = text;
  state.pendingLearnerRow = row;
  const translationLine = row.querySelector('.translation');
  translator.translate(text).then((translation) => {
    if (session === state.session && translation) translationLine.textContent = translation;
  }).catch(() => {});
  askPartner();
}

function beginTalking() {
  if (state.phase !== 'idle' || !recognizer.supported) return;
  const session = state.session;
  const done = recognizer.start();
  if (!done) return;
  voice.cancel(); // talking over the partner cuts it off, and keeps it out of the mic
  clearError();
  el.liveText.textContent = '';
  el.liveTranslation.textContent = '';
  setPhase('listening');

  done.then(({ text, error }) => {
    liveTranslation.cancel();
    if (session !== state.session || state.phase !== 'listening') return;
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      setPhase('idle');
      showError('Microphone access is blocked. Allow the microphone for this page in the browser, or type below.', false);
    } else if (error === 'audio-capture') {
      setPhase('idle');
      showError('No microphone was found. Connect one, or type below.', false);
    } else if (error === 'network') {
      setPhase('idle');
      showError('Speech recognition needs an internet connection in this browser. Check it, or type below.', false);
    } else if (!text) {
      setPhase('idle');
      el.status.textContent = "I didn't catch anything. Hold the button while you speak.";
    } else {
      submitLearner(text);
    }
  });
}

function endTalking() {
  if (state.phase === 'listening') recognizer.stop();
}

function stopConversation() {
  state.session++;
  if (state.request) state.request.abort();
  recognizer.abort();
  voice.cancel();
  liveTranslation.cancel();
  showThinking(false);
  clearError();
  setPhase('stopped');
  addSystemLine('Conversation stopped.');
}

function backToSetup() {
  el.chat.hidden = true;
  el.setup.hidden = false;
  el.start.focus();
}

// ---------- Level picker ----------

function selectLevel(level) {
  state.level = level;
  for (const button of el.levels.children) {
    const chosen = button.dataset.level === level;
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  }
  try { localStorage.setItem('level', level); } catch { /* private mode */ }
}

function buildLevelPicker(levels) {
  if (el.levels.children.length) return; // already built before a re-login
  for (const level of levels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'level';
    button.setAttribute('role', 'radio');
    button.dataset.level = level;
    const code = document.createElement('strong');
    code.textContent = level;
    const name = document.createElement('span');
    name.textContent = LEVEL_NAMES[level] || '';
    button.append(code, name);
    button.addEventListener('click', () => selectLevel(level));
    el.levels.append(button);
  }
  el.levels.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = levels[(levels.indexOf(state.level) + step + levels.length) % levels.length];
    selectLevel(next);
    el.levels.querySelector('[aria-checked="true"]').focus();
  });
  let saved = null;
  try { saved = localStorage.getItem('level'); } catch { /* private mode */ }
  selectLevel(levels.includes(saved) ? saved : DEFAULT_LEVEL);
}

// ---------- Wiring ----------

el.loginForm.addEventListener('submit', submitLogin);
el.start.addEventListener('click', startConversation);
el.stop.addEventListener('click', stopConversation);
el.restart.addEventListener('click', backToSetup);
el.retry.addEventListener('click', askPartner);

el.talk.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  el.talk.setPointerCapture(event.pointerId);
  beginTalking();
});
el.talk.addEventListener('pointerup', endTalking);
el.talk.addEventListener('pointercancel', endTalking);
el.talk.addEventListener('contextmenu', (event) => event.preventDefault());

function typingInField(event) {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || typingInField(event) || el.chat.hidden) return;
  if (state.phase !== 'idle' && state.phase !== 'listening') return;
  event.preventDefault(); // no page scroll, no button click
  if (!event.repeat) beginTalking();
});

document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || typingInField(event)) return;
  if (state.phase === 'listening') event.preventDefault();
  endTalking();
});

// Releasing outside the window would otherwise leave the mic open.
window.addEventListener('blur', endTalking);

el.typeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.typeInput.value.trim();
  if (!text || state.phase !== 'idle') return;
  el.typeInput.value = '';
  el.liveTranslation.textContent = '';
  submitLearner(text);
});

async function init() {
  let config = { levels: Object.keys(LEVEL_NAMES), demo: false };
  try {
    const response = await fetch('/api/config');
    if (response.ok) config = await response.json();
  } catch {
    el.setupNote.textContent = 'The server is not reachable. Start it with "python server.py".';
    el.setupNote.hidden = false;
  }
  if (config.authRequired && !config.signedIn) {
    showLogin();
    return;
  }
  el.setup.hidden = false;
  buildLevelPicker(config.levels);
  el.banner.hidden = true;
  if (config.demo) {
    el.banner.textContent =
      'Demo mode: the partner uses canned replies. Add an API key to .env and restart the server for real conversation.';
    el.banner.hidden = false;
  }
  if (!recognizer.supported) {
    el.setupNote.textContent =
      'This browser has no built-in speech recognition, so you can only type. Use Chrome or Edge to speak.';
    el.setupNote.hidden = false;
  }
}

init();
