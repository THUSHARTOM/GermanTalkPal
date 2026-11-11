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
export function createLiveTranslation({ translator, onResult, delay = 300 }) {
  let timer = null;
  let ticket = 0;
  let controller = null;

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
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const translation = await translator.translate(text, controller.signal);
          if (mine === ticket && translation) onResult(translation);
        } catch {
          // A missed partial translation is not worth an error message.
        }
      }, delay);
    },
    cancel,
  };
}
