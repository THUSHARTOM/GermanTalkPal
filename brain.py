"""Conversation brain: produces the partner's German follow-up and translations.

Every provider implements the same two methods, so one can replace another
without touching the server or the frontend:

    follow_up(level, history) -> {"correction": str, "reply": str, "translation": str}
    translate(text)           -> str

Groq, Google Gemini and Ollama all speak the OpenAI chat-completions format,
so a single class covers the three; only the base URL, key and model differ.
"""

import json
import re
import urllib.error
import urllib.request

LEVELS = ("A1", "A2", "B1", "B2", "C1")

LEVEL_GUIDE = {
    "A1": "Use only very basic words and short present-tense sentences. Ask simple questions about everyday things.",
    "A2": "Use simple everyday vocabulary and short sentences; the perfect tense is fine. Ask concrete questions.",
    "B1": "Use common vocabulary and clear sentences, with some subordinate clauses. Ask about experiences, opinions and plans.",
    "B2": "Use a broad vocabulary and natural, more complex sentences. Ask for reasons, comparisons and opinions.",
    "C1": "Use rich, idiomatic German and nuanced phrasing. Ask abstract, analytical or hypothetical questions.",
}

PROVIDER_DEFAULTS = {
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "openai/gpt-oss-120b",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        # The newest flash models are often overloaded on the free tier.
        "model": "gemini-3.5-flash",
        "fallback_models": ["gemini-flash-lite-latest"],
    },
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "model": "llama3.2",
    },
}

MAX_HISTORY = 20


class BrainError(Exception):
    """A provider failure with a message that is safe to show in the UI."""


class _Busy(Exception):
    """The model is overloaded or slow; another model may still answer."""


def _system_prompt(level):
    return (
        "You are a friendly German conversation partner for a language learner.\n"
        f"The learner's level is {level} (CEFR). {LEVEL_GUIDE[level]}\n"
        "Your reply is spoken aloud, so keep it short and natural.\n"
        "\n"
        "The reply:\n"
        "- Always German, pitched to that level. Never English.\n"
        "- At most two short sentences: one brief reaction to what the learner said, "
        "then exactly ONE short question on the same or a related topic.\n"
        "- One question mark in the whole reply. Never ask two things, never offer "
        "a list of options, never add a second question after 'oder'.\n"
        "- If the conversation is just starting, greet the learner and ask one easy opening question.\n"
        "- Do not mention or explain mistakes in the reply; the correction goes in its own field.\n"
        "\n"
        "The correction:\n"
        "- Look only at the learner's most recent message. It was transcribed from "
        "speech, so ignore punctuation, capitalisation and spelling.\n"
        "- If it has a real mistake (grammar, word order, case, gender, verb form, "
        "wrong word), give the corrected sentence in German, changing as little as "
        "possible and keeping the learner's own words and meaning.\n"
        "- Be gentle and fit the level: fix clear errors, do not rewrite for style "
        "or swap in fancier vocabulary.\n"
        "- If the message is correct, or there is no learner message yet, use an empty string.\n"
        "\n"
        "Answer with a JSON object only: "
        '{"correction": "<corrected German sentence, or empty>", '
        '"reply": "<your German reply>", '
        '"translation": "<natural English translation of the reply>"}'
    )


def _parse_json_object(text):
    """Models sometimes wrap JSON in prose or code fences; take the first object."""
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        match = re.search(r"\{.*\}", text or "", re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except ValueError:
                pass
    raise BrainError("The language model returned an answer the app could not read. Try again.")


class OpenAICompatibleBrain:
    def __init__(self, provider, base_url, model, api_key="", fallback_models=()):
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.fallback_models = [m for m in fallback_models if m != model]
        self.api_key = api_key

    def describe(self):
        return {"provider": self.provider, "model": self.model, "demo": False}

    def _chat(self, messages):
        """Try the main model, then the fallbacks if it is overloaded or too slow."""
        models = [self.model, *self.fallback_models]
        for index, model in enumerate(models):
            try:
                return self._chat_once(model, messages)
            except _Busy as busy:
                if index == len(models) - 1:
                    raise BrainError(str(busy))

    def _chat_once(self, model, messages, json_mode=True):
        body = {"model": model, "messages": messages, "temperature": 0.7}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {
            "Content-Type": "application/json",
            # Some providers reject the default Python user agent.
            "User-Agent": "german-speaking-partner/0.1",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            # Not every model accepts JSON mode; fall back to plain text once.
            if json_mode and error.code == 400 and "response_format" in detail:
                return self._chat_once(model, messages, json_mode=False)
            if error.code in (401, 403):
                raise BrainError(
                    f"{self.provider} rejected the API key. Check that LLM_API_KEY in .env is a "
                    f"{self.provider} key and that LLM_PROVIDER names the service it came from."
                )
            if error.code == 429:
                raise BrainError(f"{self.provider} rate limit reached. Wait a moment and try again.")
            if error.code == 404:
                raise BrainError(
                    f"{self.provider} does not know the model '{model}'. Set LLM_MODEL in .env."
                )
            if error.code in (500, 502, 503, 504):
                raise _Busy(f"{self.provider} is overloaded right now. Try again in a moment.")
            raise BrainError(f"{self.provider} returned an error ({error.code}): {detail}")
        except TimeoutError:
            raise _Busy(f"{self.provider} took too long to answer. Try again in a moment.")
        except (urllib.error.URLError, OSError) as error:
            if isinstance(getattr(error, "reason", None), TimeoutError):
                raise _Busy(f"{self.provider} took too long to answer. Try again in a moment.")
            raise BrainError(f"Could not reach {self.provider}: {getattr(error, 'reason', error)}")
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise BrainError(f"{self.provider} returned an unexpected response.")

    def follow_up(self, level, history):
        messages = [{"role": "system", "content": _system_prompt(level)}]
        for turn in history[-MAX_HISTORY:]:
            role = "assistant" if turn["role"] == "partner" else "user"
            messages.append({"role": role, "content": turn["text"]})
        if len(messages) == 1:
            messages.append({"role": "user", "content": "(The learner has just opened the app. Start the conversation.)"})
        data = _parse_json_object(self._chat(messages))
        reply = str(data.get("reply", "")).strip()
        if not reply:
            raise BrainError("The language model returned an empty reply. Try again.")
        has_learner_turn = any(turn["role"] == "learner" for turn in history)
        correction = str(data.get("correction") or "").strip() if has_learner_turn else ""
        return {
            "correction": correction,
            "reply": reply,
            "translation": str(data.get("translation", "")).strip(),
        }

    def translate(self, text):
        messages = [
            {
                "role": "system",
                "content": (
                    "Translate the German text into natural English. The text may be an "
                    "unfinished sentence; translate what is there without completing it. "
                    'Answer with a JSON object only: {"translation": "<English>"}'
                ),
            },
            {"role": "user", "content": text},
        ]
        return str(_parse_json_object(self._chat(messages)).get("translation", "")).strip()


class DemoBrain:
    """Canned replies so the app runs before an API key is configured."""

    SCRIPT = [
        ("Hallo! Schön, dass du da bist. Wie geht es dir heute?",
         "Hello! Nice that you are here. How are you today?"),
        ("Interessant! Was hast du heute schon gemacht?",
         "Interesting! What have you already done today?"),
        ("Das klingt gut. Was machst du gern in deiner Freizeit?",
         "That sounds good. What do you like to do in your free time?"),
        ("Ach so! Wie lange machst du das schon?",
         "I see! How long have you been doing that?"),
        ("Spannend. Was möchtest du am Wochenende machen?",
         "Exciting. What would you like to do at the weekend?"),
    ]

    def describe(self):
        return {"provider": "demo", "model": "canned replies", "demo": True}

    def follow_up(self, level, history):
        learner_turns = sum(1 for turn in history if turn["role"] == "learner")
        reply, translation = self.SCRIPT[learner_turns % len(self.SCRIPT)]
        # The demo brain cannot judge German, so it never offers a correction.
        return {"correction": "", "reply": reply, "translation": translation}

    def translate(self, text):
        return ""


def make_brain(env):
    provider = env.get("LLM_PROVIDER", "").strip().lower()
    api_key = env.get("LLM_API_KEY", "").strip()
    if not provider:
        provider = "groq" if api_key else "demo"
    if provider == "demo":
        return DemoBrain()
    if provider not in PROVIDER_DEFAULTS:
        raise SystemExit(
            f"Unknown LLM_PROVIDER '{provider}'. Use one of: demo, {', '.join(PROVIDER_DEFAULTS)}."
        )
    if provider != "ollama" and not api_key:
        raise SystemExit(f"LLM_PROVIDER is '{provider}' but LLM_API_KEY is empty. Add the key to .env.")
    defaults = PROVIDER_DEFAULTS[provider]
    return OpenAICompatibleBrain(
        provider=provider,
        base_url=env.get("LLM_BASE_URL", "").strip() or defaults["base_url"],
        model=env.get("LLM_MODEL", "").strip() or defaults["model"],
        api_key=api_key,
        fallback_models=defaults.get("fallback_models", ()),
    )
