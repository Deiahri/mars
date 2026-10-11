import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { AgentOpts } from './server/agent.ts';
import { desktop, token } from './server/plugin.ts';
import { signaling } from './server/signaling.ts';

export default defineConfig(({ mode }) => {
  // .env holds the API keys; they stay on the server side (no VITE_ prefix).
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (env[k]) process.env[k] = env[k];

  return {
    plugins: [
      // WebRTC signaling between the laptop page and the phone, behind the pairing token.
      signaling(token),
      // Moves/clicks the real pointer (xdotool), keystroke mode (Vosk), Orion (Claude computer use).
      desktop({
        agent: {
          model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
          effort: (env.ANTHROPIC_EFFORT || 'low') as AgentOpts['effort'],
          maxSteps: Number(env.MAX_STEPS) || 30,
          // Off unless SAFE_MODE=1: no ask-first questions, no mouse-takeover aborts.
          safeMode: env.SAFE_MODE === '1' || env.SAFE_MODE === 'true',
        },
        stt: {
          elevenKey: env.ELEVENLABS_API_KEY || undefined,
          model: env.ELEVENLABS_STT_MODEL || 'scribe_v2',
          language: env.STT_LANGUAGE || 'en',
        },
        hasClaude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
        // Claude finds snap targets in screenshots (Sonnet 5.5, a few cents per new screen). AI_SNAP=0: off at start.
        aiSnap: env.AI_SNAP !== '0' && env.AI_SNAP !== 'false',
        // Screen memory (server/memory/) recording at start. Off unless MEMORY=1: kept frames go to Anthropic.
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
