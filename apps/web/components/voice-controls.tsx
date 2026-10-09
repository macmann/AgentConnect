"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult:
    | ((e: {
        results: {
          [index: number]: { [index: number]: { transcript: string } };
        };
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};
export function VoiceControls({
  text,
  onTranscript,
  disabled,
}: {
  text: string;
  onTranscript: (text: string) => void;
  disabled: boolean;
}) {
  const [enabled, setEnabled] = useState(false),
    [supported, setSupported] = useState({ input: false, output: false }),
    [listening, setListening] = useState(false),
    [error, setError] = useState(""),
    [language, setLanguage] = useState("en-US"),
    [speaking, setSpeaking] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  useEffect(() => {
    const w = window as Window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    setSupported({
      input: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
      output: "speechSynthesis" in window,
    });
    setLanguage(navigator.language || "en-US");
    return () => {
      recognition.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);
  useEffect(() => {
    if (disabled || !text) {
      recognition.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      setListening(false);
      setSpeaking(false);
    }
  }, [disabled, text]);
  function stop() {
    recognition.current?.abort();
    setListening(false);
    if (supported.output) window.speechSynthesis.cancel();
    setSpeaking(false);
  }
  function dictate() {
    setError("");
    const w = window as Window & {
        SpeechRecognition?: new () => Recognition;
        webkitSpeechRecognition?: new () => Recognition;
      },
      Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Constructor) return;
    stop();
    const r = new Constructor();
    recognition.current = r;
    r.lang = language;
    r.interimResults = false;
    r.onresult = (e) => {
      onTranscript(e.results[0]![0]!.transcript.slice(0, 12000));
    };
    r.onerror = (e) => {
      setError(
        e.error === "not-allowed"
          ? "Microphone permission was denied. You can type your message."
          : "Speech recognition failed. You can type your message.",
      );
      setListening(false);
    };
    r.onend = () => setListening(false);
    try {
      setListening(true);
      r.start();
    } catch {
      setError("Speech recognition is unavailable. You can type your message.");
    }
  }
  function speak() {
    stop();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 16000));
    utterance.lang = language;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      setError("Speech playback is unavailable.");
    };
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }
  return (
    <div className="voice-controls">
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            stop();
          }}
        />
        Enable browser voice
      </label>
      {enabled && (
        <>
          <p className="muted">
            Voice uses your browser’s speech services, which may process
            microphone audio externally. Transcripts are editable before
            sending. Playback starts only when you ask.
          </p>
          <label>
            Speech language
            <input
              value={language}
              maxLength={35}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="en-US"
            />
          </label>
          <div className="capabilities">
            <Button
              type="button"
              className="secondary"
              onClick={dictate}
              disabled={!supported.input || disabled || listening}
            >
              Dictate message
            </Button>
            <Button
              type="button"
              className="secondary"
              onClick={speak}
              disabled={!supported.output || !text || disabled}
            >
              Read latest response
            </Button>
            <Button
              type="button"
              className="secondary"
              onClick={stop}
              disabled={!listening && !speaking}
            >
              Stop voice
            </Button>
          </div>
          {!supported.input && (
            <p>
              Speech recognition is unavailable in this browser. Type your
              message instead.
            </p>
          )}
          {listening && <p role="status">Listening…</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
