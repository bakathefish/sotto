'use strict';

const { pcm16ToWav, rms } = require('../core/wav');

const SAMPLE_RATE = 16000;

// Streaming transcription over Deepgram's websocket. One socket per speaker.
class DeepgramStream {
  constructor({ apiKey, model, language, onResult, onError }) {
    this.onResult = onResult;
    this.onError = onError;
    this.queue = [];
    const params = new URLSearchParams({
      model,
      language,
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300',
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', apiKey]);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const chunk of this.queue) this.ws.send(chunk);
      this.queue = [];
    };
    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type !== 'Results') return;
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      if (alt && alt.transcript) this.onResult({ text: alt.transcript, final: Boolean(msg.is_final) });
    };
    this.ws.onerror = () => this.onError(new Error('Deepgram connection failed. Check the API key and network.'));
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 8000);
  }

  write(pcm) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else if (this.ws.readyState === WebSocket.CONNECTING && this.queue.length < 200) this.queue.push(pcm);
  }

  close() {
    clearInterval(this.keepAlive);
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// Chunked transcription against any OpenAI-compatible /audio/transcriptions
// endpoint (OpenAI, Groq, a local whisper server). Sends a chunk when the
// speaker pauses or the chunk gets long, and skips silence.
class ChunkedStream {
  constructor({ apiKey, baseUrl, model, language, onResult, onError, fetchImpl = fetch }) {
    Object.assign(this, { apiKey, baseUrl, model, language, onResult, onError, fetchImpl });
    this.buffers = [];
    this.bytes = 0;
    this.quietBytes = 0;
    this.pending = Promise.resolve();
  }

  write(pcm) {
    const buf = Buffer.from(pcm);
    this.buffers.push(buf);
    this.bytes += buf.length;
    this.quietBytes = rms(buf) < 0.008 ? this.quietBytes + buf.length : 0;
    const seconds = this.bytes / (SAMPLE_RATE * 2);
    const quietSeconds = this.quietBytes / (SAMPLE_RATE * 2);
    if (seconds >= 12 || (seconds >= 2 && quietSeconds >= 0.7)) this.flush();
  }

  flush() {
    if (this.bytes === 0) return;
    const pcm = Buffer.concat(this.buffers);
    this.buffers = [];
    this.bytes = 0;
    this.quietBytes = 0;
    if (rms(pcm) < 0.004) return; // nothing but silence
    // Chain requests so results arrive in order.
    this.pending = this.pending.then(() => this.send(pcm)).catch((err) => this.onError(err));
  }

  async send(pcm) {
    const form = new FormData();
    form.append('file', new Blob([pcm16ToWav(pcm, SAMPLE_RATE)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    if (this.language) form.append('language', this.language);
    const headers = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
    const res = await this.fetchImpl(this.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers,
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (json.text && json.text.trim()) this.onResult({ text: json.text.trim(), final: true });
  }

  close() {
    this.flush();
  }
}

function createStream({ settings, secrets, onResult, onError }) {
  const cfg = settings.stt;
  if (cfg.provider === 'deepgram') {
    if (!secrets.deepgram) throw new Error('No Deepgram API key. Add one in the dashboard.');
    return new DeepgramStream({ apiKey: secrets.deepgram, model: cfg.deepgramModel, language: cfg.language, onResult, onError });
  }
  if (cfg.provider === 'openai') {
    return new ChunkedStream({
      apiKey: secrets.sttOpenai || secrets.openai,
      baseUrl: cfg.openaiBaseUrl,
      model: cfg.openaiModel,
      language: cfg.language,
      onResult,
      onError,
    });
  }
  throw new Error('Transcription is off. Choose a provider in the dashboard.');
}

module.exports = { createStream, ChunkedStream, DeepgramStream, SAMPLE_RATE };
