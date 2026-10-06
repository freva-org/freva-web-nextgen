// Voice: speak a message into the composer (the browser's speech recognition) and hear a reply
// read aloud (the browser's speech synthesis). Neither goes through Freva or ClimateClaw. Where
// the browser recognises speech with a remote service (Chrome without its on-device model), the
// first use says so and asks first.

/** The parts of the Web Speech API used here (not in TypeScript's DOM library). */
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionConstructor {
  new (): Recognition;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
}
interface RecognitionResultEvent extends Event {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

const CONSENT_KEY = "climateclaw:voice-consent";

function recognitionClass(): RecognitionConstructor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canDictate(): boolean {
  return recognitionClass() !== null;
}

export function canSpeak(): boolean {
  return typeof globalThis.speechSynthesis !== "undefined";
}

/** Whether this browser recognises speech on the device (nothing leaves it). */
export async function recognisesLocally(lang: string): Promise<boolean> {
  const Class = recognitionClass();
  if (!Class?.available) return false;
  try {
    return (await Class.available({ langs: [lang], processLocally: true })) === "available";
  } catch {
    return false;
  }
}

export function hasVoiceConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

export function rememberVoiceConsent(): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, "yes");
  } catch {
    // Asked again next time.
  }
}

/**
 * One dictation into a text: what was there stays, what is said is appended as it is recognised
 * (interim text shown, replaced by the final one). The dictation owns only what it wrote: once
 * the text is changed by anything else (the user typing), it stops and writes nothing more, so
 * an edit is never replaced by the old draft plus speech.
 */
export class Dictation {
  #recognition: Recognition | null = null;
  #listening = false;
  /** What this dictation last wrote (or found): the text is still its own while it equals this. */
  #written = "";

  constructor(
    private readonly write: (text: string) => void,
    private readonly onState: (listening: boolean, error?: string) => void,
    /** The text now, to tell the dictation's writes from anyone else's. */
    private readonly read: () => string,
  ) {}

  get listening(): boolean {
    return this.#listening;
  }

  start(base: string, lang: string, local: boolean): void {
    const Class = recognitionClass();
    if (!Class || this.#listening) return;
    const recognition = new Class();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    if (local && "processLocally" in recognition) recognition.processLocally = true;
    let final = "";
    this.#written = base;
    const join = (a: string, b: string) => (a && b && !/\s$/.test(a) ? `${a} ${b}` : a + b);
    recognition.addEventListener("result", (event) => {
      // Edited meanwhile: the edit wins, and the dictation ends.
      if (this.read() !== this.#written) {
        this.stop();
        return;
      }
      const e = event as RecognitionResultEvent;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i]!;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final = join(final, text.trim());
        else interim = join(interim, text.trim());
      }
      this.#written = join(base, join(final, interim));
      this.write(this.#written);
    });
    recognition.addEventListener("error", (event) => {
      const code = (event as Event & { error?: string }).error ?? "error";
      this.#finish(code === "no-speech" || code === "aborted" ? undefined : code);
    });
    recognition.addEventListener("end", () => this.#finish());
    this.#recognition = recognition;
    this.#listening = true;
    this.onState(true);
    try {
      recognition.start();
    } catch (error) {
      this.#finish(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    this.#recognition?.stop();
  }

  #finish(error?: string): void {
    if (!this.#listening) return;
    this.#listening = false;
    this.#recognition = null;
    this.onState(false, error);
  }
}

/** A reply as plain speech: no markup, no code, no markers. */
export function speakableText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " (figure) ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let speaking: string | null = null;

/** Reads a text aloud; reading the same again stops it. Returns whether it now speaks. */
export function toggleSpeech(id: string, text: string, onEnd: () => void): boolean {
  const synth = globalThis.speechSynthesis;
  if (!synth) return false;
  const again = speaking === id;
  synth.cancel();
  speaking = null;
  if (again || !text) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en";
  const done = () => {
    if (speaking === id) speaking = null;
    onEnd();
  };
  utterance.addEventListener("end", done);
  utterance.addEventListener("error", done);
  speaking = id;
  synth.speak(utterance);
  return true;
}

export function isSpeaking(id: string): boolean {
  return speaking === id;
}
