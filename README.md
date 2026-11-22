# MediaRemote

> Control whatever audio or video is playing on your Windows laptop (YouTube, Spotify, any browser tab, VLC, etc.) from a web remote on your phone, over the internet.

```
┌─────────────┐      broadcast       ┌──────────────────┐      broadcast      ┌──────────────────────┐
│  Phone       │ <-----------------> │ Supabase Realtime │ <-----------------> │ Windows laptop         │
│  (Vercel     │   over the internet │  (free relay,      │   over the internet │ (hidden Python agent,  │
│  web page)   │                     │   channel keyed    │                     │  reads/controls SMTC + │
│              │                     │   by a secret)      │                     │  system volume)        │
└─────────────┘                     └──────────────────┘                     └──────────────────────┘
```

## Features
- **Completely Silent**: Background Python agent runs via `pythonw.exe` and `run_hidden.vbs` (`SW_HIDE 0`) with no console window, popups, sounds, or tray icon.
- **Universal Media Detection**: Reads OS-level System Media Transport Controls (GSMTC) via WinRT; works across Spotify, Chrome, Edge, Brave, YouTube, and any browser audio/video element without browser extensions.
- **Hardware Volume & Mute**: Directly controls Windows master volume endpoints through Core Audio COM (`pycaw`) without triggering on-screen overlays.
- **Mobile-First Web Remote**: Responsive Next.js 14 web client with dynamic album-art ambient glow, 8px grid layout, accessible contrast, smooth touch scrub controls, and `prefers-reduced-motion` support.
- **Sub-50ms Latency**: Realtime bidirectional sync via Supabase Realtime broadcast channels with zero database persistence overhead.

## Project Structure
```
mediaremote/
├── mediaremote/
│   ├── SETUP.md                     # Comprehensive setup guide
│   ├── ONE_SHOT_PROMPT.md           # Technical specification
│   ├── agent/                       # Windows background agent
│   │   ├── agent.py                 # GSMTC + Core Audio + Realtime client
│   │   ├── requirements.txt         # Python dependencies
│   │   ├── run_hidden.vbs           # Silent background launcher
│   │   └── .env.example             # Agent environment template
│   ├── scripts/                     # Verification and setup scripts
│   │   ├── verify_agent.ps1         # Agent test suite
│   │   ├── verify_web.mjs           # Web test suite & build check
│   │   └── create_startup_shortcut.ps1 # Auto-start setup script
│   └── web/                         # Next.js 14 Web Remote App
│       ├── app/                     # React App Router & CSS
│       ├── package.json             # NPM package manifest
│       └── next.config.js           # Next.js configuration
└── README.md
```

## Quick Start
See the detailed walkthrough in [mediaremote/SETUP.md](mediaremote/SETUP.md).

### 1. Windows Agent Setup
```powershell
cd mediaremote/agent
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# Edit .env with your Supabase credentials and secret key
```

### 2. Run Verifications
```powershell
# In mediaremote/agent:
..\scripts\verify_agent.ps1

# In mediaremote/web:
node ..\scripts\verify_web.mjs
```

### 3. Deploy to Vercel
1. Import repository into Vercel with Root Directory set to `mediaremote/web`.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Open `https://<your-vercel-domain>.vercel.app/?key=<YOUR_SECRET_KEY>` on your phone.
