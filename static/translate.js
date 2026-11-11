// German -> English translation provider.
// Uses the browser's built-in translator where it exists (runs on the device),
// otherwise asks the backend, which uses the LLM.

export function createTranslator({ serverTranslate }) {
  let builtIn = null;
  let preparing = null;

  return {
    // Call from a click handler: the browser may need a user gesture to
    // download its language pack. Never blocks the conversation.
    prepare() {
      if (preparing || !('Translator' in self)) return;
      preparing = (async () => {
        try {
          const pair = { sourceLanguage: 'de', targetLanguage: 'en' };
          if ((await self.Translator.availability(pair)) === 'unavailable') return;
          builtIn = await self.Translator.create(pair);
        } catch {
          builtIn = null;
        }
      })();
    },

    // True when translation runs on the device and costs no LLM requests.
    isLocal() {
      return Boolean(builtIn);
    },

    async translate(text, signal) {
      if (!text) return '';
      if (builtIn) {
        try {
          return await builtIn.translate(text);
        } catch {
          // Fall through to the backend.
        }
      }
      return serverTranslate(text, signal);
    },
  };
}

// Translates fast-changing partial text: waits for a short pause, and only
// ever delivers the result for the newest text.
//
// On the device this is free, so it follows the speech closely. Through the
// backend every update is an LLM request against a free-tier quota, so those
// are spaced out, and paused for a while once the provider says "too many".
const SERVER_PAUSE = 700; // ms of silence before asking the backend
const SERVER_SPACING = 3000; // at most one backend request per this many ms
const SERVER_COOLDOWN = 60000; // back off after a rate-limit answer

export function createLiveTranslation({ translator, onResult, delay = 300 }) {
  let timer = null;
  let ticket = 0;
  let controller = null;
  let nextServerCall = 0;

  function cancel() {
    clearTimeout(timer);
    ticket++;
    if (controller) controller.abort();
    controller = null;
  }

  return {
    update(text) {
      cancel();
      if (!text) return;
      const mine = ticket;
      const local = translator.isLocal();
      const wait = local ? delay : Math.max(SERVER_PAUSE, nextServerCall - Date.now());
      timer = setTimeout(async () => {
        controller = new AbortController();
        if (!local) nextServerCall = Date.now() + SERVER_SPACING;
        try {
          const translation = await translator.translate(text, controller.signal);
          if (mine === ticket && translation) onResult(translation);
        } catch (error) {
          // A missed partial translation is not worth an error message.
          if (error.status === 429) nextServerCall = Date.now() + SERVER_COOLDOWN;
        }
      }, wait);
    },
    cancel,
  };
}
