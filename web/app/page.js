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

      <header className="status" role="status" aria-live="polite">
        <span className={`statusDot ${isOffline ? "offline" : ""}`} />
        {configError
          ? "Not connected"
          : isOffline
          ? "Waiting for your laptop…"
          : "Live"}
      </header>

      {configError ? (
        <main className="body">
          <div className="placeholder">
            <h1>Can't connect yet</h1>
            <p>{configError}</p>
          </div>
        </main>
      ) : !active ? (
        <main className="body">
          <div className="placeholder">
            <h1>Nothing playing</h1>
            <p>Start something on your laptop and it'll show up here.</p>
          </div>
        </main>
      ) : (
        <main className="body">
          <div
            className="artwork"
            role="img"
            aria-label={media.title ? `${media.title} album artwork` : "Album artwork"}
            style={
              media.artwork ? { backgroundImage: `url(${media.artwork})` } : {}
            }
          />

          <div className="meta">
            <h1 className="title">{media.title || "Unknown title"}</h1>
            <p className="artist">{media.artist || "Unknown artist"}</p>
          </div>

          <div className="progress">
            <input
              className="progressBar"
              type="range"
              aria-label="Track playback position"
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

          <section className="transport" aria-label="Playback controls">
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
          </section>

          <section className="volumeRow" aria-label="Volume controls">
            <button
              className="iconBtn"
              style={{ padding: 8 }}
              onClick={() => sendCommand("mute", !media.muted)}
              aria-label={media.muted ? "Unmute" : "Mute"}
            >
              <VolumeIcon muted={media.muted} />
            </button>
            <input
              className="volumeSlider"
              type="range"
              aria-label="Master volume control"
              min={0}
              max={100}
              value={Math.round((media.volume ?? 0) * 100)}
              onChange={(e) =>
                sendCommandDebounced("volume", Number(e.target.value) / 100)
              }
            />
          </section>
        </main>
      )}
    </div>
  );
}
