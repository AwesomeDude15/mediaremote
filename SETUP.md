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

### Repository & Root Directory Configuration
If deploying from a Git repository containing the `mediaremote` project:
- Set **Root Directory** in Vercel to `mediaremote/web` (or `web` if your repository root is `mediaremote`).
- **Framework Preset**: Next.js (automatically detected).
- **Build Command**: `npx next build` or `npm run build`.
- **Output Directory**: `.next` (default).

### Environment Variables
Configure these in the Vercel Project Settings under **Environment Variables** (accessible to Production, Preview, and Development):
- `NEXT_PUBLIC_SUPABASE_URL` → your Supabase Project URL (e.g., `https://xxxxxxxxxxxx.supabase.co`).
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` → your Supabase anon public API key.

### Deployment Steps
1. Push your code to GitHub / GitLab / Bitbucket.
2. On vercel.com, click **Add New → Project**, import your repository.
3. In the project configure screen, set Root Directory to `mediaremote/web`.
4. Add the two environment variables above.
5. Click **Deploy**. Vercel will build and assign a production URL (e.g., `https://mediaremote.vercel.app`).

**Vercel CLI alternative** (no GitHub required):
From inside `mediaremote/web/`:
```bash
npx vercel
npx vercel env add NEXT_PUBLIC_SUPABASE_URL
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
npx vercel --prod
```

### Windows Startup Shortcut Verification
The automated startup shortcut can be created using the included helper script:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\create_startup_shortcut.ps1
```

To verify that the shortcut is installed correctly in the Windows Startup folder:
```powershell
powershell -ExecutionPolicy Bypass -Command "Get-ChildItem (Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup') -Filter 'MediaRemote.lnk'"
```
To inspect target properties and working directory:
```powershell
powershell -ExecutionPolicy Bypass -Command "`$sh = New-Object -ComObject WScript.Shell; `$sc = `$sh.CreateShortcut((Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MediaRemote.lnk')); [PSCustomObject]@{ Target = `$sc.TargetPath; WorkingDir = `$sc.WorkingDirectory; Description = `$sc.Description }"
```

---

## Architecture & Tech Stack Rationale

MediaRemote was designed around three architectural pillars: **zero-install mobile client**, **universal background host integration**, and **low-latency cross-network relay**.

### 1. Host Agent: Windows GSMTC (`winsdk`) + Core Audio (`pycaw`) in Python 3.12
- **Universal Media Controls (`winsdk.windows.media.control`)**: Rather than relying on site-specific browser extensions, userscript hacks, or DOM query selectors that break whenever websites update, Windows Global System Media Transport Controls (GSMTC) exposes an OS-level WinRT interface. Chromium browsers (Chrome, Edge, Brave, Opera) and native players (Spotify, VLC, iTunes) register active media sessions with GSMTC automatically.
- **Silent System Volume Manipulation (`pycaw`)**: Controlling master volume via synthetic keystrokes (`VK_VOLUME_UP` / `VK_VOLUME_DOWN`) triggers Windows' on-screen volume flyouts/HUDs, violating the silence requirement. `pycaw` communicates directly with the Windows Core Audio COM endpoints (`IAudioEndpointVolume`), modifying volume levels and mute states silently without UI flashes or sound cues.
- **Python 3.12 Daemon**: Python 3.12 provides official precompiled C-extension binary wheels on PyPI for `winsdk 1.0.0b10` and `realtime 2.34+`, enabling zero-compiler setup on any Windows machine via `uv`.

### 2. Client Web Application: Next.js 14 App Router + Accessible HTML5
- **Zero Mobile App Installation**: Next.js provides a responsive, mobile-first Web application that can be bookmarked or saved as a PWA home screen icon on any mobile OS (iOS Safari, Android Chrome) without app store friction.
- **Accessibility & 8px Grid System**: Structured with semantic HTML5 elements (`<header>`, `<main>`, `<section>`), ARIA labels on playback and volume range inputs, and spacing strictly aligned to an 8px grid system.
- **Reduced Motion Compliance**: Implements `@media (prefers-reduced-motion: reduce)` to disable non-essential transitions and pulsing animations for users with motion sensitivity.
- **Dynamic CSS Variables & Canvas Sampling**: Dynamically extracts dominant accent colors from album artwork using an off-screen HTML5 `<canvas>` and applies them to CSS custom properties (`--accent`, `--status-live`), creating an immersive ambient background glow.

### 3. Relay Layer: Supabase Realtime Broadcast (WebSockets)
- **Direct WebSockets without Database Overhead**: Uses ephemeral Realtime broadcast channels (`mediaremote-{SECRET_KEY}`). State updates and transport commands are relayed directly in memory over WebSockets with sub-50ms latency without database row writes or table polling.
- **NAT / Firewall Traversal**: Works seamlessly across disparate networks (e.g. phone on cellular 5G and laptop on coffee shop Wi-Fi) without router port forwarding, DDNS, or VPNs.

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
