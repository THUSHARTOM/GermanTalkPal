// Text-to-speech provider. Phase 2 uses the browser's built-in German voices.
// A replacement (a streaming TTS API) only has to offer the same shape:
// supported, prepare(), speak(text, {rate, onEnd}), cancel().

const synth = window.speechSynthesis;

function isGerman(voice) {
  return voice.lang.replace('_', '-').toLowerCase().startsWith('de');
}

// Prefer the more natural-sounding voices where the device has several.
function score(voice) {
  let points = 0;
  if (/natural|neural|online/i.test(voice.name)) points += 4;
  if (/google/i.test(voice.name)) points += 2;
  if (/^de[-_]de$/i.test(voice.lang)) points += 1;
  return points;
}

export function createVoice({ lang = 'de-DE' } = {}) {
  let voice = null;
  let current = null;

  function pickVoice() {
    const german = synth.getVoices().filter(isGerman);
    voice = german.sort((a, b) => score(b) - score(a))[0] || null;
  }

  return {
    supported: Boolean(synth),

    // Voices load asynchronously in most browsers; start that early.
    prepare() {
      if (!synth) return;
      pickVoice();
      synth.addEventListener('voiceschanged', pickVoice);
    },

    speak(text, { rate = 1, onEnd } = {}) {
      if (!synth || !text) return;
      this.cancel();
      if (!voice) pickVoice();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = voice ? voice.lang : lang;
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      const finish = () => {
        if (current !== utterance) return;
        current = null;
        if (onEnd) onEnd();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      current = utterance;
      synth.speak(utterance);
    },

    // Cut off anything that is playing or queued.
    cancel() {
      if (!synth) return;
      const interrupted = current;
      current = null;
      synth.cancel();
      if (interrupted && interrupted.onend) interrupted.onend = interrupted.onerror = null;
    },
  };
}
