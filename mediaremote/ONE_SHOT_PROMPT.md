# Build Prompt: MediaRemote (one-shot, self-verifying)

Paste this entire document to a coding agent (e.g. Claude Code) as a single
task. It contains the complete, already-written, already-verified source for
the whole project, plus the exact steps to assemble it, run it, and check it
actually works — so it should succeed in one pass with no back-and-forth.

## What you're building

**MediaRemote**: a phone-accessible remote control for whatever audio or
video is playing on a Windows laptop (YouTube, Spotify, any browser tab,
etc.), controllable from anywhere with internet — not just the same wifi.

```
┌─────────────┐      broadcast       ┌──────────────────┐      broadcast      ┌──────────────────────┐
│  Phone       │ <-----------------> │ Supabase Realtime │ <-----------------> │ Windows laptop         │
│  (Vercel     │   over the internet │  (free relay,      │   over the internet │ (hidden Python agent,  │
│  web page)   │                     │   channel keyed    │                     │  reads/controls SMTC + │
│              │                     │   by a secret)      │                     │  system volume)        │
└─────────────┘                     └──────────────────┘                     └──────────────────────┘
```

- **Laptop side**: a Python script that runs invisibly in the background. It
  reads Windows' System Media Transport Controls (SMTC) — the same system
  that powers the Windows volume flyout's "now playing" card and hardware
  media keys — and the system master volume, via `pycaw`. It publishes state
  and receives commands over a Supabase Realtime broadcast channel.
- **Phone side**: a Next.js page deployed to Vercel. No app install — it's a
  bookmarked URL containing a secret key. It shows album art, title, artist,
  a seek bar, transport controls, and volume/mute, all live.
- **Relay**: a free Supabase project, used only for its Realtime "broadcast"
  feature (no database tables needed). The channel name is derived from a
  secret key so only someone with the link can control the laptop.

## Non-negotiable requirements

1. **Completely silent on the laptop, always.** No console window ever (use
   `pythonw.exe`, never `python.exe`, for real use). No toast/balloon
   notifications, no `MessageBox` popups, no sounds, no tray icon (that's an
   intentionally deferred future feature — do not add one now). Programmatic
   volume/playback changes must not trigger Windows' on-screen overlays
   (verified: those overlays are tied to physical key presses, not API
   calls, so this is already satisfied by the implementation below — do not
   change the volume/playback control mechanism in a way that could
   reintroduce them, e.g. do NOT simulate hardware media-key presses).
2. **Universal across every website and app**, not a specific one. This is
   achieved by reading the OS-level SMTC session rather than integrating
   with any particular site or player. Chromium-based browsers (Chrome,
   Edge, Brave, Opera, Arc) register a SMTC session for literally any
   playing `<video>`/`<audio>` element, regardless of whether that website
   implements the Media Session API — sites that do (YouTube, Spotify Web
   Player, SoundCloud, Apple Music web, etc.) give rich title/artist/
   artwork; sites that don't still work, just with plainer metadata. Firefox
   works too as long as `media.hardwaremediakeys.enabled` is `true` in
   `about:config` (the default). Never hardcode logic for a specific site —
   if you find yourself writing a URL check or site-specific selector,
   that's a sign you've drifted from the architecture; stop and reconsider.
3. **Works over the internet, not just shared wifi** (hence Supabase
   Realtime as a relay, not a direct LAN connection).
4. **Simple shared-secret access control** — a long random string embedded
   in the phone's URL and the laptop's `.env`. This is intentionally not
   full auth; document the security tradeoff, don't "upgrade" it unasked.
5. **Auto-reconnects** on network drops, sleep/wake, and Supabase project
   cold-starts, with exponential backoff.
6. Code must handle missing/partial data gracefully (no title, no artwork,
   no duration, no active session) without crashing.

## Exact file tree to produce

```
mediaremote/
├── SETUP.md
├── agent/
│   ├── .env.example
│   ├── .gitignore
│   ├── agent.py
│   ├── requirements.txt
│   └── run_hidden.vbs
├── scripts/
│   ├── verify_agent.ps1
│   └── verify_web.mjs
└── web/
    ├── .env.local.example
    ├── .gitignore
    ├── next.config.js
    ├── package.json
    └── app/
        ├── globals.css
        ├── layout.js
        └── page.js
```

## Step 1 — Create every file exactly as given below

Create each file at the exact path shown, with **exactly** the content in
its code block — this content has already been validated (API usage checked
against current library documentation; the Next.js app has been built
successfully end-to-end with `next build`). Do not "improve", refactor, or
second-guess the implementation details (library import paths, GSMTC
property names, Supabase Realtime API shape, CSS) — they were chosen
deliberately and verified. You may fix a genuine bug you discover during
verification in Step 2, but if you do, re-run the full verification after.

-e 
## Step 1 (continued) — file contents

### `agent/.env.example`

```ini
# Copy this file to ".env" in the same folder and fill in your own values.

# Supabase dashboard -> Project Settings -> API -> "Project URL"
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co

# Supabase dashboard -> Project Settings -> API -> "anon public" key
SUPABASE_ANON_KEY=eyJhbGciOi...

# A long random string only you and your phone know. Treat it like a password.
SECRET_KEY=change-me-to-something-long-and-random
```

### `agent/requirements.txt`

```text
winsdk>=1.0.0b10
pycaw>=20230407
comtypes>=1.2.0
realtime>=2.30.0
python-dotenv>=1.0.0
```

### `agent/agent.py`

```python
"""
MediaRemote agent — runs hidden in the background on Windows.

What it does:
  - Reads whatever is currently playing system-wide (YouTube/Spotify/Edge/Chrome/
    anything that reports to Windows' media transport controls) using the
    GlobalSystemMediaTransportControlsSessionManager (GSMTC) API.
  - Reads/sets the system master volume and mute via pycaw.
  - Connects to a Supabase Realtime "broadcast" channel named after your secret
    key, publishes now-playing state, and listens for commands sent from the
    phone page.

Run it with pythonw.exe (not python.exe) so no console window ever appears.
See ../SETUP.md for how to configure and auto-start this.

HARD REQUIREMENTS — do not violate these when editing this file:
  1. SILENT: no console windows, no MessageBox/toast/balloon notifications,
     no sounds, no taskbar flashes, no tray icon (yet). The only acceptable
     output is stdout text, and only when launched with python.exe for
     debugging — pythonw.exe swallows it entirely in normal use.
  2. UNIVERSAL: this must work for *any* site or app that plays audio/video,
     not a specific one. It achieves that by reading the OS-level System
     Media Transport Controls (SMTC) session rather than talking to any
     particular website or player — Chromium browsers (Chrome, Edge, Brave,
     etc.) register a SMTC session for essentially any playing <video>/
     <audio> element automatically, regardless of whether the site itself
     implements the Media Session API. Sites that do implement it (YouTube,
     Spotify Web Player, SoundCloud...) additionally provide rich title/
     artist/artwork; sites that don't still work, just with generic/missing
     metadata — handle that gracefully (see the "Unknown title" fallback in
     the web UI), never assume fields are present.
"""

import asyncio
import base64
import os
import sys
import time
import traceback

from dotenv import load_dotenv

from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
)
from winsdk.windows.storage.streams import DataReader, Buffer, InputStreamOptions

from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
from comtypes import CLSCTX_ALL

from realtime import AsyncRealtimeClient, RealtimeSubscribeStates

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")

if not SUPABASE_URL or not SUPABASE_ANON_KEY or not SECRET_KEY:
    print("Missing SUPABASE_URL, SUPABASE_ANON_KEY or SECRET_KEY in agent/.env")
    sys.exit(1)

# Supabase dashboard shows "https://xxxx.supabase.co" — turn that into the
# realtime websocket URL the client library expects.
REALTIME_URL = SUPABASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/realtime/v1"
CHANNEL_NAME = f"mediaremote-{SECRET_KEY}"

STATE_EVENT = "state"
COMMAND_EVENT = "command"

MAX_ARTWORK_BYTES = 200_000  # skip sending artwork if a thumbnail is unusually large
RESYNC_INTERVAL_SEC = 5      # send a full state update at least this often
POLL_INTERVAL_SEC = 1        # how often we check Windows for changes


# ---------------------------------------------------------------------------
# System volume (pycaw)
# ---------------------------------------------------------------------------

def _get_volume_interface():
    speakers = AudioUtilities.GetSpeakers()
    interface = speakers.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    return interface.QueryInterface(IAudioEndpointVolume)


def get_volume_state():
    try:
        vol = _get_volume_interface()
        return {
            "volume": round(vol.GetMasterVolumeLevelScalar(), 3),
            "muted": bool(vol.GetMute()),
        }
    except Exception:
        return {"volume": None, "muted": None}


def set_system_volume(scalar: float):
    scalar = max(0.0, min(1.0, float(scalar)))
    vol = _get_volume_interface()
    vol.SetMasterVolumeLevelScalar(scalar, None)


def set_system_mute(muted: bool):
    vol = _get_volume_interface()
    vol.SetMute(1 if muted else 0, None)


# ---------------------------------------------------------------------------
# Media session (GSMTC)
# ---------------------------------------------------------------------------

async def _get_manager():
    return await MediaManager.request_async()


async def _read_thumbnail(thumb_ref):
    """thumb_ref is a RandomAccessStreamReference; returns (data_uri, None) or (None, None)."""
    if thumb_ref is None:
        return None
    try:
        stream = await thumb_ref.open_read_async()
        size = stream.size
        if size == 0 or size > MAX_ARTWORK_BYTES:
            return None
        buffer = Buffer(size)
        await stream.read_async(buffer, size, InputStreamOptions.READ_AHEAD)
        reader = DataReader.from_buffer(buffer)
        raw = bytearray(size)
        reader.read_bytes(raw)
        content_type = getattr(stream, "content_type", None) or "image/png"
        b64 = base64.b64encode(bytes(raw)).decode("ascii")
        return f"data:{content_type};base64,{b64}"
    except Exception:
        return None


async def read_media_state():
    """Returns a dict describing what's currently playing, or a minimal 'nothing' state."""
    try:
        manager = await _get_manager()
        session = manager.get_current_session()
        if session is None:
            return {"active": False}

        props = await session.try_get_media_properties_async()
        playback_info = session.get_playback_info()
        timeline = session.get_timeline_properties()

        # PlaybackStatus: 0 Closed, 1 Opened, 2 Changing, 3 Stopped, 4 Playing, 5 Paused
        status = int(playback_info.playback_status)
        is_playing = status == 4

        position_ms = int(timeline.position.total_seconds() * 1000) if timeline else 0
        duration_ms = int(timeline.end_time.total_seconds() * 1000) if timeline else 0

        artwork = await _read_thumbnail(props.thumbnail if props else None)

        return {
            "active": True,
            "title": (props.title if props else "") or "",
            "artist": (props.artist if props else "") or "",
            "app": session.source_app_user_model_id or "",
            "isPlaying": is_playing,
            "positionMs": max(0, position_ms),
            "durationMs": max(0, duration_ms),
            "artwork": artwork,
        }
    except Exception:
        traceback.print_exc()
        return {"active": False}


async def apply_command(action: str, value):
    try:
        manager = await _get_manager()
        session = manager.get_current_session()

        if action in ("play", "pause", "toggle", "next", "previous", "seek") and session is None:
            return

        if action == "play":
            await session.try_play_async()
        elif action == "pause":
            await session.try_pause_async()
        elif action == "toggle":
            status = int(session.get_playback_info().playback_status)
            if status == 4:
                await session.try_pause_async()
            else:
                await session.try_play_async()
        elif action == "next":
            await session.try_skip_next_async()
        elif action == "previous":
            await session.try_skip_previous_async()
        elif action == "seek":
            timeline = session.get_timeline_properties()
            duration_ticks = int(timeline.end_time.total_seconds() * 10_000_000)
            fraction = max(0.0, min(1.0, float(value)))
            target_ticks = int(duration_ticks * fraction)
            await session.try_change_playback_position_async(target_ticks)
        elif action == "volume":
            set_system_volume(value)
        elif action == "mute":
            set_system_mute(bool(value))
    except Exception:
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Realtime glue
# ---------------------------------------------------------------------------

def build_state_payload(media, vol):
    payload = dict(media)
    payload["volume"] = vol.get("volume")
    payload["muted"] = vol.get("muted")
    payload["ts"] = time.time()
    return payload


async def run():
    backoff = 2
    while True:
        try:
            client = AsyncRealtimeClient(REALTIME_URL, SUPABASE_ANON_KEY)
            channel = client.channel(
                CHANNEL_NAME, {"config": {"broadcast": {"ack": False, "self": False}}}
            )

            def on_command(payload):
                data = payload.get("payload", payload)
                action = data.get("action")
                value = data.get("value")
                asyncio.create_task(apply_command(action, value))
                # Optimistic resync shortly after a command so the phone sees
                # the real new state, not just its own guess.
                asyncio.create_task(resync_soon(channel))

            channel.on_broadcast(COMMAND_EVENT, on_command)

            subscribed = asyncio.Event()

            def on_subscribe(status, err):
                if status == RealtimeSubscribeStates.SUBSCRIBED:
                    print("Connected to Supabase Realtime.")
                    subscribed.set()
                elif status == RealtimeSubscribeStates.CHANNEL_ERROR:
                    print("Channel error:", err)
                elif status == RealtimeSubscribeStates.TIMED_OUT:
                    print("Realtime server did not respond in time.")
                elif status == RealtimeSubscribeStates.CLOSED:
                    print("Realtime channel closed.")

            await channel.subscribe(on_subscribe)
            backoff = 2  # reset after a successful connect

            last_sent = None
            last_sent_at = 0.0

            while True:
                media = await read_media_state()
                vol = get_volume_state()
                state = build_state_payload(media, vol)

                comparable = {k: v for k, v in state.items() if k not in ("ts", "positionMs")}
                changed = comparable != last_sent
                stale = (time.time() - last_sent_at) > RESYNC_INTERVAL_SEC

                if changed or stale:
                    await channel.send_broadcast(STATE_EVENT, state)
                    last_sent = comparable
                    last_sent_at = time.time()

                await asyncio.sleep(POLL_INTERVAL_SEC)

        except Exception:
            traceback.print_exc()
            print(f"Reconnecting in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


async def resync_soon(channel):
    await asyncio.sleep(0.6)
    media = await read_media_state()
    vol = get_volume_state()
    state = build_state_payload(media, vol)
    try:
        await channel.send_broadcast(STATE_EVENT, state)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
```

### `agent/run_hidden.vbs`

```vbscript
' Launches the agent with zero visible window — not even a flash.
' Edit the path below if you put this folder somewhere other than
' the default location suggested in SETUP.md.

Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
pythonw = scriptDir & "\venv\Scripts\pythonw.exe"
agent = scriptDir & "\agent.py"

shell.Run """" & pythonw & """ """ & agent & """", 0, False
```

### `agent/.gitignore`

```text
venv
.env
__pycache__
```

### `web/package.json`

```json
{
  "name": "mediaremote-web",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@supabase/supabase-js": "^2.45.4"
  }
}
```

### `web/next.config.js`

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;
```

### `web/.env.local.example`

```ini
# Copy to .env.local for local dev, and set the same two values as
# Environment Variables in your Vercel project settings for deployment.

NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

### `web/app/layout.js`

```javascript
import "./globals.css";

export const metadata = {
  title: "Remote",
  description: "Control what's playing on your laptop, from your phone.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

### `web/app/globals.css`

```css
:root {
  --bg: #0a0a0d;
  --ink: #f3f2ef;
  --ink-dim: rgba(243, 242, 239, 0.62);
  --ink-faint: rgba(243, 242, 239, 0.38);
  --accent: #6c8ef2;
  --accent-ink: #0a0a0d;
  --surface: rgba(255, 255, 255, 0.06);
  --surface-strong: rgba(255, 255, 255, 0.12);
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  box-sizing: border-box;
}

* {
  box-sizing: inherit;
}

html,
body {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
    Arial, sans-serif;
  overscroll-behavior: none;
}

button {
  font-family: inherit;
  color: inherit;
}

.screen {
  position: relative;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  padding: calc(20px + var(--safe-top)) 24px calc(20px + var(--safe-bottom));
  overflow: hidden;
}

.backdrop {
  position: fixed;
  inset: -10%;
  background-size: cover;
  background-position: center;
  filter: blur(70px) saturate(1.4) brightness(0.4);
  transform: scale(1.15);
  transition: background-image 700ms ease, opacity 700ms ease;
  z-index: 0;
}

.backdrop::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(10, 10, 13, 0.35) 0%,
    rgba(10, 10, 13, 0.55) 45%,
    rgba(10, 10, 13, 0.92) 100%
  );
}

.status {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-faint);
  margin-bottom: auto;
}

.statusDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
  flex-shrink: 0;
}

.statusDot.offline {
  background: var(--ink-faint);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.body {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  margin: auto 0;
  width: 100%;
  max-width: 420px;
  margin-left: auto;
  margin-right: auto;
}

.artwork {
  width: min(58vw, 220px);
  height: min(58vw, 220px);
  border-radius: 18px;
  background: var(--surface);
  background-size: cover;
  background-position: center;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  transition: background-image 500ms ease;
}

.meta {
  text-align: center;
  width: 100%;
}

.title {
  font-size: clamp(20px, 6vw, 28px);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.artist {
  font-size: 15px;
  color: var(--ink-dim);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  width: 100%;
}

.progressBar {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-strong);
  accent-color: var(--accent);
  cursor: pointer;
}

.times {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
  margin-top: 8px;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 32px;
}

.iconBtn {
  background: none;
  border: none;
  padding: 10px;
  cursor: pointer;
  color: var(--ink);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.85;
  transition: opacity 150ms ease, transform 150ms ease;
}

.iconBtn:active {
  transform: scale(0.92);
  opacity: 1;
}

.playBtn {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
  transition: transform 150ms ease, background 400ms ease;
}

.playBtn:active {
  transform: scale(0.94);
}

.volumeRow {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
}

.volumeSlider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-strong);
  accent-color: var(--ink-dim);
  cursor: pointer;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--ink-dim);
  text-align: center;
  padding: 0 16px;
}

.placeholder h1 {
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
  margin: 0;
}

.placeholder p {
  font-size: 14px;
  margin: 0;
  color: var(--ink-faint);
}
```

### `web/app/page.js`

```javascript
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const STATE_EVENT = "state";
const COMMAND_EVENT = "command";
const OFFLINE_AFTER_MS = 12000;

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Samples a small canvas to find an approximate dominant color for an image,
// so the player's accent tint matches whatever's actually playing.
function extractAccentColor(dataUri) {
  return new Promise((resolve) => {
    if (!dataUri) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 12;
        canvas.height = 12;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 12, 12);
        const { data } = ctx.getImageData(0, 0, 12, 12);
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);
        // Push toward a readable mid-brightness so it works as a button fill.
        const boost = (c) => Math.min(255, Math.round(c * 0.6 + 90));
        resolve(`rgb(${boost(r)}, ${boost(g)}, ${boost(b)})`);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUri;
  });
}

function PlayIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1" />
    </svg>
  );
}
function NextIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5v14l9-7z" />
      <rect x="16" y="5" width="2.5" height="14" />
    </svg>
  );
}
function PrevIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 5v14l-9-7z" />
      <rect x="5.5" y="5" width="2.5" height="14" />
    </svg>
  );
}
function VolumeIcon({ muted }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      {muted ? (
        <path
          d="M16 8l5 8M21 8l-5 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M16.5 8.5c1.2 1 1.9 2.2 1.9 3.5s-.7 2.5-1.9 3.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
}

export default function Page() {
  const [secretKey, setSecretKey] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [media, setMedia] = useState(null); // last state payload from the agent
  const [lastSeenAt, setLastSeenAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [accent, setAccent] = useState("#6c8ef2");
  const [dragPositionMs, setDragPositionMs] = useState(null);

  const channelRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("key");
    if (!key) {
      setConfigError(
        "Open this page with your secret key in the link, e.g. ?key=yourkey"
      );
      return;
    }
    setSecretKey(key);
  }, []);

  useEffect(() => {
    if (!secretKey) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      setConfigError(
        "This deployment is missing its Supabase environment variables."
      );
      return;
    }

    const supabase = createClient(url, anonKey);
    const channel = supabase.channel(`mediaremote-${secretKey}`, {
      config: { broadcast: { ack: false, self: false } },
    });

    channel.on("broadcast", { event: STATE_EVENT }, ({ payload }) => {
      setMedia(payload);
      setLastSeenAt(Date.now());
    });

    channel.subscribe();
    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [secretKey]);

  // Local clock, both to animate the progress bar between updates and to
  // detect when the laptop has gone quiet.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (media?.artwork) {
      extractAccentColor(media.artwork).then((c) => c && setAccent(c));
    } else {
      setAccent("#6c8ef2");
    }
  }, [media?.artwork]);

  const sendCommand = useCallback((action, value) => {
    channelRef.current?.send({
      type: "broadcast",
      event: COMMAND_EVENT,
      payload: { action, value },
    });
  }, []);

  const sendCommandDebounced = useCallback(
    (action, value) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => sendCommand(action, value), 180);
    },
    [sendCommand]
  );

  const isOffline = !media || now - lastSeenAt > OFFLINE_AFTER_MS;
  const active = media?.active && !isOffline;

  const duration = media?.durationMs || 0;
  const elapsedSinceUpdate =
    media?.isPlaying && !isOffline ? now - lastSeenAt : 0;
  const livePosition = Math.min(
    duration || Infinity,
    (media?.positionMs || 0) + elapsedSinceUpdate
  );
  const shownPosition = dragPositionMs ?? livePosition;

  const rootStyle = { "--accent": accent };

  return (
    <div className="screen" style={rootStyle}>
      {active && media?.artwork && (
        <div
          className="backdrop"
          style={{ backgroundImage: `url(${media.artwork})` }}
        />
      )}
      {active && !media?.artwork && <div className="backdrop" />}

      <div className="status">
        <span className={`statusDot ${isOffline ? "offline" : ""}`} />
        {configError
          ? "Not connected"
          : isOffline
          ? "Waiting for your laptop…"
          : "Live"}
      </div>

      {configError ? (
        <div className="body">
          <div className="placeholder">
            <h1>Can't connect yet</h1>
            <p>{configError}</p>
          </div>
        </div>
      ) : !active ? (
        <div className="body">
          <div className="placeholder">
            <h1>Nothing playing</h1>
            <p>Start something on your laptop and it'll show up here.</p>
          </div>
        </div>
      ) : (
        <div className="body">
          <div
            className="artwork"
            style={
              media.artwork ? { backgroundImage: `url(${media.artwork})` } : {}
            }
          />

          <div className="meta">
            <p className="title">{media.title || "Unknown title"}</p>
            <p className="artist">{media.artist || "Unknown artist"}</p>
          </div>

          <div className="progress">
            <input
              className="progressBar"
              type="range"
              min={0}
              max={duration || 1}
              value={Math.min(shownPosition, duration || 1)}
              onChange={(e) => setDragPositionMs(Number(e.target.value))}
              onMouseUp={(e) => {
                const fraction = duration ? Number(e.target.value) / duration : 0;
                sendCommand("seek", fraction);
                setTimeout(() => setDragPositionMs(null), 400);
              }}
              onTouchEnd={(e) => {
                const fraction = duration
                  ? Number(e.target.value) / duration
                  : 0;
                sendCommand("seek", fraction);
                setTimeout(() => setDragPositionMs(null), 400);
              }}
            />
            <div className="times">
              <span>{formatTime(shownPosition)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="transport">
            <button
              className="iconBtn"
              onClick={() => sendCommand("previous")}
              aria-label="Previous"
            >
              <PrevIcon />
            </button>
            <button
              className="playBtn"
              onClick={() => sendCommand("toggle")}
              aria-label={media.isPlaying ? "Pause" : "Play"}
            >
              {media.isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              className="iconBtn"
              onClick={() => sendCommand("next")}
              aria-label="Next"
            >
              <NextIcon />
            </button>
          </div>

          <div className="volumeRow">
            <button
              className="iconBtn"
              style={{ padding: 6 }}
              onClick={() => sendCommand("mute", !media.muted)}
              aria-label={media.muted ? "Unmute" : "Mute"}
            >
              <VolumeIcon muted={media.muted} />
            </button>
            <input
              className="volumeSlider"
              type="range"
              min={0}
              max={100}
              value={Math.round((media.volume ?? 0) * 100)}
              onChange={(e) =>
                sendCommandDebounced("volume", Number(e.target.value) / 100)
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

### `web/.gitignore`

```text
node_modules
.next
.env.local
```

### `scripts/verify_agent.ps1`

```powershell
# Self-verification for the Windows agent.
# Run from the `agent` folder: ..\scripts\verify_agent.ps1
# Exits non-zero and prints a FAIL line for the first problem it finds.

$ErrorActionPreference = "Stop"
$fail = $false

function Pass($msg) { Write-Host "PASS - $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "FAIL - $msg" -ForegroundColor Red; $script:fail = $true }

# 1. Python present and new enough
try {
    $verOut = (python --version) 2>&1
    if ($verOut -match "Python 3\.(\d+)") {
        if ([int]$Matches[1] -ge 11) { Pass "Python version: $verOut" }
        else { Fail "Python 3.11+ required, found $verOut" }
    } else { Fail "Could not parse python --version output: $verOut" }
} catch { Fail "python not found on PATH" }

# 2. Virtual environment exists
if (Test-Path ".\venv\Scripts\python.exe") { Pass "venv exists" }
else { Fail "venv missing — run: python -m venv venv" }

# 3. Dependencies import cleanly inside the venv
$importCheck = & .\venv\Scripts\python.exe -c "import winsdk, pycaw, comtypes, realtime, dotenv; print('OK')" 2>&1
if ($importCheck -match "OK") { Pass "All required packages import successfully" }
else { Fail "Dependency import failed: $importCheck" }

# 4. agent.py has no syntax errors
$compileCheck = & .\venv\Scripts\python.exe -m py_compile agent.py 2>&1
if ($LASTEXITCODE -eq 0) { Pass "agent.py compiles with no syntax errors" }
else { Fail "agent.py failed to compile: $compileCheck" }

# 5. .env exists and looks filled in (not left as placeholders)
if (-not (Test-Path ".\.env")) {
    Fail ".env missing — copy .env.example to .env and fill in your values"
} else {
    $envText = Get-Content ".\.env" -Raw
    if ($envText -match "xxxxxxxxxxxx" -or $envText -match "change-me-to-something") {
        Fail ".env still contains placeholder values from .env.example"
    } else {
        Pass ".env exists and placeholders have been replaced"
    }
}

# 6. Static scan: this file must never grow silence-breaking code
$forbidden = @("MessageBox", "winsound", "playsound", "notify(", "ToastNotification", "plyer")
$src = Get-Content ".\agent.py" -Raw
$hit = $forbidden | Where-Object { $src -match [regex]::Escape($_) }
if ($hit) { Fail "agent.py contains forbidden silence-breaking code: $($hit -join ', ')" }
else { Pass "No notification/sound/popup code present (silence requirement holds)" }

# 7. Live connection smoke test (only if .env looks configured)
if (Test-Path ".\.env") {
    Write-Host "Running agent.py for 8 seconds to confirm it connects..."
    $proc = Start-Process -FilePath ".\venv\Scripts\python.exe" -ArgumentList "agent.py" `
        -RedirectStandardOutput "verify_stdout.tmp.txt" -RedirectStandardError "verify_stderr.tmp.txt" `
        -NoNewWindow -PassThru
    Start-Sleep -Seconds 8
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $out = Get-Content "verify_stdout.tmp.txt" -Raw -ErrorAction SilentlyContinue
    Remove-Item "verify_stdout.tmp.txt", "verify_stderr.tmp.txt" -ErrorAction SilentlyContinue
    if ($out -match "Connected to Supabase Realtime") { Pass "Agent connected to Supabase Realtime" }
    else { Fail "Agent did not report a successful connection within 8s. Output was: $out" }
}

if ($fail) {
    Write-Host "`nOne or more checks FAILED. Fix the issues above before relying on this build." -ForegroundColor Red
    exit 1
} else {
    Write-Host "`nAll checks PASSED." -ForegroundColor Green
    exit 0
}
```

### `scripts/verify_web.mjs`

```javascript
// Self-verification for the Vercel web app.
// Run from the `web` folder: node ../scripts/verify_web.mjs
// Prints PASS/FAIL lines; exits 1 if anything fails.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

let failed = false;
const pass = (msg) => console.log(`PASS - ${msg}`);
const fail = (msg) => {
  console.log(`FAIL - ${msg}`);
  failed = true;
};
const run = (cmd) => execSync(cmd, { stdio: "pipe" }).toString();

// 1. package.json has the required dependencies
try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const required = ["next", "react", "react-dom", "@supabase/supabase-js"];
  const missing = required.filter((dep) => !pkg.dependencies?.[dep]);
  if (missing.length) fail(`package.json missing dependencies: ${missing.join(", ")}`);
  else pass("package.json declares all required dependencies");
} catch (e) {
  fail(`Could not read/parse package.json: ${e.message}`);
}

// 2. Install dependencies
try {
  run("npm install");
  pass("npm install succeeded");
} catch (e) {
  fail(`npm install failed: ${e.stdout?.toString() || e.message}`);
}

// 3. Env file present (at least the example) and the two required keys are referenced in code
if (!existsSync(".env.local.example")) fail(".env.local.example is missing");
else pass(".env.local.example present");

const pageSrc = readFileSync("app/page.js", "utf8");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
  if (pageSrc.includes(key)) pass(`page.js references ${key}`);
  else fail(`page.js does not reference ${key}`);
}

// 4. Production build succeeds (uses placeholder env vars so build doesn't fail
//    on missing values — real values are provided at deploy time on Vercel)
try {
  run(
    'NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npx next build'
  );
  pass("next build succeeded");
} catch (e) {
  fail(`next build failed: ${e.stdout?.toString() || e.message}`);
}

// 5. Static scan: no accidental secrets committed, no server-only envs leaked wrong way
const envExample = readFileSync(".env.local.example", "utf8");
if (/eyJ[A-Za-z0-9_-]{20,}\./.test(envExample.replace("eyJhbGciOi...", "")))
  fail(".env.local.example appears to contain a real key, not a placeholder");
else pass("No real secrets committed in .env.local.example");

if (failed) {
  console.log("\nOne or more checks FAILED.");
  process.exit(1);
} else {
  console.log("\nAll checks PASSED.");
  process.exit(0);
}
```

### `SETUP.md`

````markdown
# MediaRemote — setup guide

Control whatever's playing on your Windows laptop (YouTube, Spotify, any
browser tab, etc.) from a page on your phone, over the internet.

```
Phone (Vercel page)  <-- Supabase Realtime -->  Laptop (Python agent, hidden)
```

Nothing is installed on your phone — it's just a web page. The laptop side is
a small Python script that runs invisibly in the background.

---

## 1. Create a free Supabase project (the relay)

1. Go to supabase.com, sign in, and create a new project (pick any name/region).
2. Wait for it to finish provisioning (a minute or two).
3. Go to **Project Settings → API**. You need two values from this page:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon public** key (a long string starting with `eyJ...`)
4. That's it — no database tables or extra setup needed. This project only
   uses Supabase's realtime "broadcast" feature, which works out of the box.

⚠️ **Free Supabase projects pause themselves after about a week with no
activity.** Since the agent talks to it constantly whenever it's running,
this shouldn't happen in normal use — but if you come back after a long
break and it doesn't connect, open the Supabase dashboard once to wake the
project back up.

## 2. Pick a secret key

This is the "password" that lets your phone's page talk to your laptop. Make
up a long, random, hard-to-guess string — for example, open a terminal and
run:

```
python -c "import secrets; print(secrets.token_urlsafe(24))"
```

Anyone with this key (and your Vercel link) can control your laptop's media
and volume, so treat it like a password — don't post the link publicly.

## 3. Set up the Windows agent

In `agent/`:

1. Install Python 3.11+ if you don't have it (python.org).
2. Open a terminal in the `agent` folder and run:
   ```
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill in:
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` from step 1
   - `SECRET_KEY` from step 2
4. Test it first **with a visible console** so you can see errors:
   ```
   venv\Scripts\python agent.py
   ```
   Play something in a browser tab or Spotify, and you should see
   `Connected to Supabase Realtime.` printed. Leave it running for now.

### Run it fully hidden

Once it works, use `pythonw.exe` instead of `python.exe` — it runs with no
console window at all:

```
venv\Scripts\pythonw.exe agent.py
```

### Start automatically and silently every time you log in

1. Press `Win + R`, type `shell:startup`, hit Enter. This opens your Startup
   folder.
2. Right-click `run_hidden.vbs` (in the `agent` folder) → **Create shortcut**.
3. Drag that shortcut into the Startup folder you just opened.

Now the agent starts silently in the background every time you log into
Windows — no window, no taskbar icon, nothing visible. (We're intentionally
skipping a tray icon for now so it's invisible for your trick — that can be
added later.)

To stop it at any time, open **Task Manager → Details tab**, find
`pythonw.exe`, and end it.

## 4. Deploy the web page to Vercel

In `web/`:

1. Push this folder to a GitHub repo (or use the Vercel CLI directly — see
   below).
2. On vercel.com, **Add New → Project**, import that repo.
3. Before deploying, add two **Environment Variables** in the Vercel project
   settings:
   - `NEXT_PUBLIC_SUPABASE_URL` → your Supabase Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → your Supabase anon key
4. Deploy. Vercel will give you a URL like `https://your-app.vercel.app`.

**Vercel CLI alternative** (no GitHub needed): from inside `web/`, run
`npx vercel`, follow the prompts, then `npx vercel env add` twice to set the
two variables above, then `npx vercel --prod`.

## 5. Use it

On your phone, open:

```
https://your-app.vercel.app/?key=YOUR_SECRET_KEY
```

Bookmark it or save it to your home screen. As long as your laptop is on and
the agent is running, you'll see what's playing and can control it —
play/pause, skip, seek, volume, mute — from anywhere with internet, not just
the same wifi.

---

## Silence & universality — how these are actually guaranteed

**Silent:** the agent never opens a window, never shows a notification/toast/
balloon, and never plays a sound. Programmatic volume and play/pause changes
(via pycaw and GSMTC) do **not** trigger Windows' on-screen volume HUD or any
"now playing" overlay — those overlays are tied to physical hardware key
presses, not API calls, so they stay invisible with this approach. Running
via `pythonw.exe` means there is no console window either, even briefly.

**Universal:** the agent reads Windows' System Media Transport Controls
(SMTC) — the same system-wide "now playing" session that powers the Windows
volume flyout and your keyboard's media keys. Chromium-based browsers
(Chrome, Edge, Brave, Opera, Arc) register *any* playing `<video>`/`<audio>`
element with SMTC automatically, for every website, whether or not that
site specifically implements the Media Session API. Sites that do implement
it (YouTube, Spotify Web Player, SoundCloud, Apple Music web, etc.) give you
rich title/artist/artwork; sites that don't will still be controllable, just
with plainer (or missing) metadata, which the agent and web page already
handle with fallbacks ("Unknown title", etc.). Firefox supports this too as
long as `media.hardwaremediakeys.enabled` is `true` in `about:config` (the
default).

One inherent limitation: SMTC exposes a single "current" session system-wide
— if you have several tabs playing at once, you control whichever one
Windows currently considers active (usually whatever you started or
interacted with most recently), not all of them simultaneously. That's a
Windows limitation, not something this project can route around.

## Troubleshooting

- **Page says "Nothing playing" even though something is playing:** Windows
  only reports a session to apps that have been interacted with recently —
  click play/pause once in the browser tab or app and it should appear.
- **Page never leaves "Waiting for your laptop…":** double check the laptop
  is actually running the agent (`Task Manager` for `pythonw.exe`), and that
  `SECRET_KEY` matches exactly on both sides.
- **"Channel error" when testing the agent with a visible console:** usually
  a wrong Supabase URL/key, or the project is paused (open the Supabase
  dashboard to wake it).
- **Volume controls don't do anything:** they control the laptop's *system*
  volume (the Windows mixer), not an individual app's volume slider.

## What's next (not built yet, on purpose)

You mentioned wanting a tray icon with connection status later — the agent
is structured so that's a small addition (just a loop + a tray library like
`pystray`) once you're ready to add it.
````
-e 

## Step 2 — Self-verification (must all pass before you report done)

Run these in order. If any step fails, diagnose and fix the root cause,
then **re-run every step from the top** — don't assume a fix in isolation.
Do not report the project as complete until every check below prints PASS
(or, for the two non-scripted manual checks, until you've confirmed them
yourself and stated how).

### 2a. Web app (works on any OS with Node 18+; run first, it's the
quicker feedback loop)

```
cd mediaremote/web
node ../scripts/verify_web.mjs
```

This installs dependencies, confirms `page.js` references both required
env vars, and runs a real `next build` with placeholder env values. All
lines must read `PASS`. If `npm install` fails with a filesystem error
about symlinks, you're on a filesystem that doesn't support them (some
sandboxed/network mounts) — re-run from a normal local directory; this is
an environment issue, not a code bug.

### 2b. Windows agent (must run on an actual Windows machine with Python
3.11+ — the GSMTC and pycaw APIs are Windows-only and cannot be verified
on Linux/macOS; if you are not on Windows, do the static checks only:
`python -m py_compile agent.py` must succeed, and `pip install -r
requirements.txt` into a throwaway venv must succeed with no errors, and
clearly tell the user the live-connection check still needs to be run on
their Windows machine)

```
cd mediaremote/agent
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# edit .env: fill in SUPABASE_URL, SUPABASE_ANON_KEY (from a real Supabase
# project's Project Settings -> API page) and a random SECRET_KEY
..\scripts\verify_agent.ps1
```

All lines must read `PASS`, including the live "Agent connected to
Supabase Realtime" check, which proves the whole relay path actually works
end to end. This requires a real (free) Supabase project to exist first —
if the user hasn't provided credentials yet, say so explicitly and give
them the two values you need, rather than inventing placeholder ones and
declaring success.

### 2c. Manual checks you must perform and explicitly confirm

- Start something playing in a browser tab (any site), run
  `venv\Scripts\python agent.py` (visible console, for this test only),
  confirm the console shows no crash and `Connected to Supabase Realtime.`
  appears.
- Confirm **zero visible UI** appears anywhere on screen when you trigger a
  play/pause/volume change through the agent (no toast, no overlay, no
  console flash) — run it via `pythonw.exe` for this check, not
  `python.exe`.
- Confirm the behavior is not site-specific: test with at least two
  different websites (e.g. a YouTube video and a Spotify Web Player track,
  or any two arbitrary sites with a `<video>`/`<audio>` element) and
  confirm both are detected without any code change.
- Open the deployed (or `next dev`) web page with `?key=<your secret>` on a
  phone or a second browser and confirm play/pause/next/previous/seek/
  volume/mute all round-trip to the laptop within a second or two.

## Step 3 — Deploy

1. Push `mediaremote/web` to a GitHub repo (or use `npx vercel` directly
   from inside that folder).
2. In the Vercel project settings, add environment variables
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` with the
   same values used in the agent's `.env`.
3. Deploy. Confirm the resulting URL loads and shows "Nothing playing" (not
   an error page) before anything is playing on the laptop.
4. Set up the Windows Startup shortcut to `run_hidden.vbs` as described in
   `SETUP.md`, confirm by rebooting (or logging out/in) that the agent
   starts automatically and silently.

## Definition of done

Report completion only when **all** of the following are true, and list
them explicitly in your final summary:

- [ ] All 15 files created exactly as specified, at the exact paths.
- [ ] `verify_web.mjs` — all PASS.
- [ ] `verify_agent.ps1` — all PASS, including the live Supabase connection
      check (or, if not run on Windows, clearly state this is outstanding
      and exactly what the user needs to run and where).
- [ ] Manual silence check performed and confirmed (no visible UI of any
      kind during normal operation).
- [ ] Manual cross-site check performed with at least two unrelated
      websites, confirming no site-specific code exists.
- [ ] Web page deployed and reachable at a real Vercel URL.
- [ ] Windows Startup shortcut created and confirmed working after a
      logout/login or reboot.
- [ ] The user has been given: the Vercel URL with `?key=...` appended,
      and told explicitly to bookmark/save it and not share it publicly.

If any box can't be checked (e.g. no Windows machine available in this
environment, or no Supabase account yet), say so plainly and list exactly
what the user needs to do themselves to finish that box — never mark it
done without having actually verified it.
