import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

type WakeWordState = 'idle' | 'listening';
type DictationState = 'idle' | 'listening';

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface StartRecordingOptions {
  onFinalTranscript?: (text: string) => void | Promise<void>;
}

interface StartDictationOptions {
  onFinalTranscript?: (text: string) => void | Promise<void>;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [wakeWordState, setWakeWordState] = useState<WakeWordState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [wakeWordAvailable, setWakeWordAvailable] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const monitorTimerRef = useRef<number | null>(null);
  const speechStartedRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const wakeWordRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wakeWordCallbackRef = useRef<(() => void) | null>(null);
  const wakeWordActiveRef = useRef(false);
  const wakeWordRestartTimerRef = useRef<number | null>(null);
  const dictationRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationCallbackRef = useRef<StartDictationOptions['onFinalTranscript'] | null>(null);
  const dictationActiveRef = useRef(false);
  const dictationRestartTimerRef = useRef<number | null>(null);
  const startRecordingRef = useRef<((options?: StartRecordingOptions) => Promise<void>) | null>(null);
  const finalTranscriptCallbackRef = useRef<StartRecordingOptions['onFinalTranscript'] | null>(null);

  const stopMonitoring = useCallback(() => {
    if (monitorTimerRef.current) {
      clearInterval(monitorTimerRef.current);
      monitorTimerRef.current = null;
    }
    sourceNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    sourceNodeRef.current = null;
    silenceStartedAtRef.current = null;
    speechStartedRef.current = false;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  const stopWakeWordListening = useCallback(() => {
    wakeWordActiveRef.current = false;
    wakeWordCallbackRef.current = null;
    if (wakeWordRestartTimerRef.current) {
      clearTimeout(wakeWordRestartTimerRef.current);
      wakeWordRestartTimerRef.current = null;
    }

    const recognition = wakeWordRecognitionRef.current;
    if (recognition) {
      wakeWordRecognitionRef.current = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        try {
          recognition.stop();
        } catch {}
      }
    }

    setWakeWordState('idle');
  }, []);

  const stopDictationListening = useCallback(() => {
    dictationActiveRef.current = false;
    dictationCallbackRef.current = null;
    if (dictationRestartTimerRef.current) {
      clearTimeout(dictationRestartTimerRef.current);
      dictationRestartTimerRef.current = null;
    }

    const recognition = dictationRecognitionRef.current;
    if (recognition) {
      dictationRecognitionRef.current = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        try {
          recognition.stop();
        } catch {}
      }
    }

    setDictationState('idle');
    if (!mediaRecorderRef.current) {
      setState('idle');
    }
  }, []);

  const startDictationListening = useCallback(async (options?: StartDictationOptions): Promise<void> => {
    setError(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      const fallback = startRecordingRef.current;
      if (fallback) {
        await fallback({
          onFinalTranscript: options?.onFinalTranscript,
        });
      }
      return;
    }

    finalTranscriptCallbackRef.current = null;
    stopWakeWordListening();
    stopDictationListening();

    setWakeWordAvailable(true);
    dictationCallbackRef.current = options?.onFinalTranscript ?? null;
    dictationActiveRef.current = true;
    setDictationState('listening');
    setState('recording');

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    const restart = () => {
      if (!dictationActiveRef.current || dictationRecognitionRef.current) {
        return;
      }
      if (dictationRestartTimerRef.current) {
        clearTimeout(dictationRestartTimerRef.current);
      }
      dictationRestartTimerRef.current = window.setTimeout(() => {
        dictationRestartTimerRef.current = null;
        if (!dictationActiveRef.current || dictationRecognitionRef.current) {
          return;
        }
        try {
          recognition.start();
          dictationRecognitionRef.current = recognition;
        } catch {
          dictationRecognitionRef.current = null;
          dictationActiveRef.current = false;
          setDictationState('idle');
          setError('Could not start voice capture');
        }
      }, 300);
    };

    recognition.onresult = (event: any) => {
      if (!dictationActiveRef.current) return;
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        transcript += `${result[0]?.transcript ?? ''} `;
        if (result.isFinal) {
          finalTranscript += `${result[0]?.transcript ?? ''} `;
        }
      }
      const current = transcript.trim();
      if (current) {
        setLastTranscript(current);
      }
    };

    recognition.onerror = (event: any) => {
      const errorName = String(event?.error ?? '');
      if (errorName === 'not-allowed' || errorName === 'service-not-allowed') {
        setError('Voice capture needs microphone permission');
        stopDictationListening();
        return;
      }
      if (errorName === 'no-speech' || errorName === 'aborted') {
        return;
      }
      dictationRecognitionRef.current = null;
      restart();
    };

    recognition.onend = async () => {
      dictationRecognitionRef.current = null;
      if (dictationActiveRef.current) {
        const transcript = finalTranscript.trim();
        if (transcript) {
          setLastTranscript(transcript);
          const callback = dictationCallbackRef.current;
          dictationCallbackRef.current = null;
          dictationActiveRef.current = false;
          setDictationState('idle');
          setState('idle');
          await callback?.(transcript);
          return;
        }
        restart();
      } else {
        setDictationState('idle');
        setState('idle');
      }
    };

    dictationRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      dictationRecognitionRef.current = null;
      stopDictationListening();
      setError('Could not start voice capture');
    }
  }, [stopDictationListening, stopWakeWordListening]);

  const startWakeWordListening = useCallback(async (onWakeWord: () => void): Promise<void> => {
    setError(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setWakeWordAvailable(false);
      setWakeWordState('idle');
      return;
    }

    setWakeWordAvailable(true);
    wakeWordCallbackRef.current = onWakeWord;
    wakeWordActiveRef.current = true;
    setWakeWordState('listening');

    const existing = wakeWordRecognitionRef.current;
    if (existing) {
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    const wakeWords = [/\bjarvis\b/i, /\bhey jarvis\b/i, /\bokay jarvis\b/i];

    const restart = () => {
      if (!wakeWordActiveRef.current || wakeWordRecognitionRef.current) {
        return;
      }
      if (wakeWordRestartTimerRef.current) {
        clearTimeout(wakeWordRestartTimerRef.current);
      }
      wakeWordRestartTimerRef.current = window.setTimeout(() => {
        wakeWordRestartTimerRef.current = null;
        if (!wakeWordActiveRef.current || wakeWordRecognitionRef.current) {
          return;
        }
        try {
          recognition.start();
          wakeWordRecognitionRef.current = recognition;
        } catch {
          wakeWordRecognitionRef.current = null;
          wakeWordActiveRef.current = false;
          setWakeWordState('idle');
          setError('Could not start wake word listening');
        }
      }, 300);
    };

    recognition.onresult = (event: any) => {
      if (!wakeWordActiveRef.current) return;

      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += `${event.results[i][0]?.transcript ?? ''} `;
      }
      const normalized = transcript.trim().toLowerCase();
      if (!normalized) return;

      if (wakeWords.some((pattern) => pattern.test(normalized))) {
        wakeWordActiveRef.current = false;
        const callback = wakeWordCallbackRef.current;
        stopWakeWordListening();
        callback?.();
      }
    };

    recognition.onerror = (event: any) => {
      const errorName = String(event?.error ?? '');
      if (errorName === 'not-allowed' || errorName === 'service-not-allowed') {
        setError('Wake word needs microphone permission');
        stopWakeWordListening();
        return;
      }
      if (errorName === 'no-speech' || errorName === 'aborted') {
        return;
      }
      wakeWordRecognitionRef.current = null;
      restart();
    };

    recognition.onend = () => {
      wakeWordRecognitionRef.current = null;
      if (wakeWordActiveRef.current) {
        restart();
      } else {
        setWakeWordState('idle');
      }
    };

    wakeWordRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      wakeWordRecognitionRef.current = null;
      stopWakeWordListening();
      setError('Could not start wake word listening');
    }
  }, [stopWakeWordListening]);

  const stopRecordingNow = useCallback((recorder: MediaRecorder | null): boolean => {
    if (!recorder || recorder.state !== 'recording') {
      return false;
    }
    stopMonitoring();
    recorder.stop();
    return true;
  }, [stopMonitoring]);

  // Check if speech backend is available on mount
  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => setAvailable(health.available))
      .catch(() => setAvailable(false));
    setWakeWordAvailable(Boolean(getSpeechRecognitionCtor()));
  }, []);

  const startRecording = useCallback(async (options?: StartRecordingOptions): Promise<void> => {
    setError(null);
    setLastTranscript(null);
    finalTranscriptCallbackRef.current = options?.onFinalTranscript ?? null;
    stopWakeWordListening();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        const sourceNode = audioContext.createMediaStreamSource(stream);
        sourceNode.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceNodeRef.current = sourceNode;

        const sampleBuffer = new Uint8Array(analyser.fftSize);
        const silenceDelayMs = 1200;
        const volumeThreshold = 0.018;
        monitorTimerRef.current = window.setInterval(() => {
          const currentRecorder = mediaRecorderRef.current;
          const currentAnalyser = analyserRef.current;
          if (!currentRecorder || !currentAnalyser || currentRecorder.state !== 'recording') {
            return;
          }

          currentAnalyser.getByteTimeDomainData(sampleBuffer);
          let sumSquares = 0;
          for (let i = 0; i < sampleBuffer.length; i += 1) {
            const centered = sampleBuffer[i] - 128;
            sumSquares += centered * centered;
          }
          const level = Math.sqrt(sumSquares / sampleBuffer.length) / 128;
          const now = Date.now();

          if (level > volumeThreshold) {
            speechStartedRef.current = true;
            silenceStartedAtRef.current = null;
            return;
          }

          if (!speechStartedRef.current) {
            return;
          }

          if (silenceStartedAtRef.current == null) {
            silenceStartedAtRef.current = now;
            return;
          }

          if (now - silenceStartedAtRef.current >= silenceDelayMs) {
            stopRecordingNow(currentRecorder);
          }
        }, 120);
      } catch {
        stopMonitoring();
      }

      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setState('recording');
    } catch (err) {
      finalTranscriptCallbackRef.current = null;
      setError('Microphone access denied');
      setState('idle');
    }
  }, [stopMonitoring, stopRecordingNow]);

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        setState('transcribing');
        stopMonitoring();
        mediaRecorderRef.current = null;

        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          const transcript = result.text ?? '';
          setLastTranscript(transcript);
          const callback = finalTranscriptCallbackRef.current;
          finalTranscriptCallbackRef.current = null;
          if (callback) {
            await callback(transcript);
          }
          setState('idle');
          resolve(transcript);
        } catch (err) {
          finalTranscriptCallbackRef.current = null;
          setLastTranscript(null);
          setState('idle');
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      stopRecordingNow(recorder);
    });
  }, [stopMonitoring, stopRecordingNow]);

  useEffect(() => {
    return () => {
      stopWakeWordListening();
      stopDictationListening();
      stopMonitoring();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
    };
  }, [stopDictationListening, stopMonitoring, stopWakeWordListening]);

  return {
    state,
    dictationState,
    wakeWordState,
    error,
    available,
    wakeWordAvailable,
    startRecording,
    startDictationListening,
    stopRecording,
    startWakeWordListening,
    stopWakeWordListening,
    stopDictationListening,
    lastTranscript,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
