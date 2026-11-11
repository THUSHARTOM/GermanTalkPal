# German Speaking Partner — phases 1 and 2

The core loop: level picker, push-to-talk, live transcript and translation,
a German follow-up question spoken aloud, a gentle correction under your
sentence when it had a mistake, and a Stop button that also cuts off audio.

## Run

```bash
python server.py
```

Then open http://localhost:8000 in Chrome or Edge (they have the built-in
speech recognition). Nothing to install: the backend uses only the Python
standard library and the frontend has no build step.

## Real conversation

Without a key the partner runs in demo mode with canned replies.

1. Copy `.env.example` to `.env`.
2. Put a free-tier key in `LLM_API_KEY` (Groq by default; set
   `LLM_PROVIDER=gemini` for Google Gemini, or `LLM_PROVIDER=ollama` for a
   local model with no key).
3. Restart the server.

## Share it (deploy)

Hosting gives you an HTTPS link that works on phones and that a friend can
open. The app is protected by one shared password, `APP_PASSWORD`; the server
refuses to start on a public address without it.

The `Dockerfile` runs on any container host. With Render's free plan:

1. Put this `german-partner` folder in a **private** GitHub repository.
   `.env` is ignored by git, so your key stays on your PC.
2. On render.com create a **Web Service** from that repository. It picks up
   the `Dockerfile`. Choose the free instance type.
3. Add three environment variables in the service's settings:
   - `LLM_PROVIDER` = `gemini`
   - `LLM_API_KEY` = your key
   - `APP_PASSWORD` = a long password of your choice
4. Deploy. Open the `https://….onrender.com` address it gives you, enter the
   password, and send the link and the password to your friend.

Things to know:

- A free Render service sleeps after 15 minutes without visitors and takes
  about a minute to wake up on the next visit.
- Everyone with the password uses your API key and its free-tier limits.
- To lock everyone out, change `APP_PASSWORD` and redeploy; all sessions end.
- Eight wrong passwords from one visitor block further tries for ten minutes.

## Layout

| File | Job |
| --- | --- |
| `server.py` | Serves the page, keeps the key off the browser, `/api/turn` and `/api/translate` |
| `brain.py` | Conversation brain: one class for Groq, Gemini and Ollama, plus the demo brain |
| `static/app.js` | The turn loop and the screen |
| `static/speech.js` | Speech-to-text provider (browser built-in) |
| `static/translate.js` | Translation provider (browser built-in, else the backend LLM) |
| `static/voice.js` | Text-to-speech provider (browser built-in German voice) |

Corrections come from the LLM, so demo mode never shows one.

## Not built yet

The rest of phase 3: streaming, reconnects, a spending cap, tests, and
installing to the phone's home screen. On a phone the microphone needs HTTPS, which comes with
deployment (see "Share it" above); on the laptop use `localhost`.
