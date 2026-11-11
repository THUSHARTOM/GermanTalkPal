// Speech-to-text provider. Phase 1 uses the browser's built-in recognition.
// A replacement (Whisper in the browser, a streaming API) only has to offer
// the same shape: supported, start() -> Promise<{text, error}>, stop(), abort().

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createRecognizer({ lang = 'de-DE', onPartial }) {
  let active = null;

  return {
    supported: Boolean(Recognition),

    // Starts listening. Resolves once recognition has fully ended, with the
    // final transcript and the error code, if any.
    start() {
      if (!Recognition || active) return null;

      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.interimResults = true;
      recognition.continuous = true;
      active = recognition;

      let finalText = '';
      let interimText = '';
      let error = null;

      recognition.onresult = (event) => {
        interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finalText += result[0].transcript + ' ';
          else interimText += result[0].transcript;
        }
        onPartial((finalText + interimText).replace(/\s+/g, ' ').trim());
      };

      recognition.onerror = (event) => {
        error = event.error;
      };

      return new Promise((resolve) => {
        recognition.onend = () => {
          if (active === recognition) active = null;
          resolve({ text: (finalText + interimText).replace(/\s+/g, ' ').trim(), error });
        };
        try {
          recognition.start();
        } catch (startError) {
          active = null;
          resolve({ text: '', error: 'start-failed' });
        }
      });
    },

    // Finish the utterance and deliver what was heard.
    stop() {
      if (active) active.stop();
    },

    // Drop the utterance.
    abort() {
      if (active) active.abort();
    },
  };
}
