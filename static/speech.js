// Speech-to-text provider. Phase 1 uses the browser's built-in recognition.
// A replacement (Whisper in the browser, a streaming API) only has to offer
// the same shape: supported, start() -> Promise<{text, error}>, stop(), abort().

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createRecognizer({ lang = 'de-DE', onPartial }) {
  let active = null;
  let watchdog = null;
  let finishActive = () => {};

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
        const finish = () => {
          if (active !== recognition) return; // already finished
          active = null;
          clearTimeout(watchdog);
          resolve({ text: (finalText + interimText).replace(/\s+/g, ' ').trim(), error });
        };
        finishActive = finish;
        recognition.onend = finish;
        try {
          recognition.start();
        } catch (startError) {
          error = 'start-failed';
          finish();
        }
      });
    },

    // Ask for the microphone before the first hold. Call from a click handler.
    // Without this the browser's permission prompt opens in the middle of the
    // first hold, which breaks that recording.
    // Resolves to 'granted', 'denied' or 'unknown'.
    async prepare() {
      if (!Recognition || !navigator.mediaDevices?.getUserMedia) return 'unknown';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return 'granted';
      } catch (micError) {
        return micError.name === 'NotAllowedError' || micError.name === 'SecurityError' ? 'denied' : 'unknown';
      }
    },

    // Finish the utterance and deliver what was heard.
    stop() {
      if (!active) return;
      const recognition = active;
      recognition.stop();
      // Some browsers never report the end of a recording that was stopped
      // before it really began. Do not let that block the next one.
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (active !== recognition) return;
        try { recognition.abort(); } catch { /* already gone */ }
        finishActive();
      }, 2500);
    },

    // Drop the utterance.
    abort() {
      if (active) active.abort();
    },
  };
}
