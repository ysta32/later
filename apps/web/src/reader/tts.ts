/** Split plain text into speakable chunks: by paragraph, long paragraphs split at sentence boundaries. */
export function chunkText(text: string, maxLen = 400): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n|\r?\n/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length <= maxLen) {
      out.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p];
    let cur = "";
    for (const s of sentences) {
      if (cur && (cur + s).length > maxLen) {
        out.push(cur.trim());
        cur = "";
      }
      if (s.length > maxLen) {
        // no sentence break available: split on words
        for (const w of s.split(" ")) {
          if (cur && (cur + " " + w).length > maxLen) {
            out.push(cur.trim());
            cur = "";
          }
          cur += (cur ? " " : "") + w;
        }
      } else cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

export type TtsState = "idle" | "playing" | "paused";

export interface TtsOptions {
  chunks: string[];
  synth?: SpeechSynthesis;
  onChunk?: (index: number) => void;
  onState?: (state: TtsState) => void;
}

export interface TtsController {
  play(from?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(r: number): void;
  setVoice(uri: string | null): void;
  readonly state: TtsState;
}

export function ttsSupported(): boolean {
  return (
    typeof globalThis.speechSynthesis !== "undefined" &&
    typeof globalThis.SpeechSynthesisUtterance !== "undefined"
  );
}

export function createTts(opts: TtsOptions): TtsController {
  const synth = opts.synth ?? globalThis.speechSynthesis;
  let state: TtsState = "idle";
  let index = 0;
  let rate = 1;
  let voiceUri: string | null = null;
  let session = 0; // invalidates callbacks from cancelled utterances

  const set = (s: TtsState) => {
    state = s;
    opts.onState?.(s);
  };

  const speak = () => {
    if (index >= opts.chunks.length) {
      set("idle");
      return;
    }
    const mine = ++session;
    const u = new SpeechSynthesisUtterance(opts.chunks[index]);
    u.rate = rate;
    const v = voiceUri ? synth.getVoices().find((x) => x.voiceURI === voiceUri) : undefined;
    if (v) u.voice = v;
    opts.onChunk?.(index);
    u.onend = () => {
      if (mine === session && state === "playing") {
        index++;
        speak();
      }
    };
    u.onerror = () => {
      if (mine === session && state === "playing") {
        set("idle");
      }
    };
    synth.speak(u);
  };

  return {
    play(from = 0) {
      session++;
      synth.cancel();
      index = Math.max(0, from);
      set("playing");
      speak();
    },
    pause() {
      if (state === "playing") {
        synth.pause();
        set("paused");
      }
    },
    resume() {
      if (state === "paused") {
        synth.resume();
        set("playing");
      }
    },
    stop() {
      session++;
      synth.cancel();
      index = 0;
      set("idle");
    },
    setRate(r) {
      rate = Math.min(2.5, Math.max(0.5, r));
      if (state === "playing") {
        session++;
        synth.cancel();
        speak();
      } // restart current paragraph at new rate
    },
    setVoice(uri) {
      voiceUri = uri;
      if (state === "playing") {
        session++;
        synth.cancel();
        speak();
      }
    },
    get state() {
      return state;
    },
  };
}
