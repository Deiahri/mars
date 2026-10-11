import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { AgentOpts } from './server/agent.ts';
import { desktop, token } from './server/plugin.ts';
import { signaling } from './server/signaling.ts';

export default defineConfig(({ mode }) => {
  // .env holds the API keys; they stay on the server side (no VITE_ prefix).
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of ['GEMINI_API_KEY', 'GEMINI_MODEL']) if (env[k]) process.env[k] = env[k];

  return {
    plugins: [
      // WebRTC signaling between the laptop page and the phone, behind the pairing token.
      signaling(token),
      // Moves/clicks the real pointer (xdotool), keystroke mode (Vosk), Mars (Gemini computer use).
      desktop({
        agent: {
          model: env.GEMINI_MODEL || 'gemini-3.8-flash',
          // 'low' keeps a step at ~5 s; Gemini's default thinking took ~45 s for one key press.
          thinking: (env.GEMINI_THINKING || 'low') as AgentOpts['thinking'],
          maxSteps: Number(env.MAX_STEPS) || 30,
          // Off unless SAFE_MODE=1: no ask-first questions, no mouse-takeover aborts.
          safeMode: env.SAFE_MODE === '1' || env.SAFE_MODE === 'true',
        },
        stt: {
          elevenKey: env.ELEVENLABS_API_KEY || undefined,
          model: env.ELEVENLABS_STT_MODEL || 'scribe_v2',
          language: env.STT_LANGUAGE || 'en',
        },
        voice: {
          elevenKey: env.ELEVENLABS_API_KEY || undefined,
          // "George", a premade voice every account has.
          voiceId: env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
          model: env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
          enabled: env.TTS !== '0' && env.TTS !== 'false',
        },
        backboardKey: env.BACKBOARD_API_KEY || undefined,
        // "Hey Mars" (offline Vosk) on at start. WAKE=0: off until turned on.
        wake: env.WAKE !== '0' && env.WAKE !== 'false',
        hasGemini: Boolean(process.env.GEMINI_API_KEY),
        // Gemini finds snap targets in screenshots (box_2d detection, a fraction of a cent per new screen). AI_SNAP=0: off at start.
        aiSnap: env.AI_SNAP !== '0' && env.AI_SNAP !== 'false',
        // Screen memory (server/memory/) recording at start. Off unless MEMORY=1: kept frames go to Google (Gemini).
        memory: env.MEMORY === '1' || env.MEMORY === 'true',
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          remote: fileURLToPath(new URL('./remote.html', import.meta.url)),
        },
      },
    },
    server: {
      // Loopback only: this server moves your mouse. The phone comes in through ngrok
      // (`ngrok http 127.0.0.1:5176`), which connects from here.
      host: '127.0.0.1',
      port: 5176,
      strictPort: true,
      allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    },
  };
});
