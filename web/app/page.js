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

// Samples a small canvas to find an approximate dominant color for an image
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

function PlayIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function PauseIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1" />
    </svg>
  );
}

function NextIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 5v14l9-7z" />
      <rect x="16" y="5" width="2.5" height="14" />
    </svg>
  );
}

function PrevIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18 5v14l-9-7z" />
      <rect x="5.5" y="5" width="2.5" height="14" />
    </svg>
  );
}

function VolumeIcon({ muted }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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

function MediaIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" opacity="0.4" aria-hidden="true">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

export default function Page() {
  const [secretKey, setSecretKey] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [media, setMedia] = useState(null);
  const [lastSeenAt, setLastSeenAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [accent, setAccent] = useState("#6c8ef2");
  const [dragPositions, setDragPositions] = useState({});
  const channelRef = useRef(null);
  const volDebounceRef = useRef(null);

  // Read ?key= from the URL once on mount
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

  // Connect to Supabase Realtime channel
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

  // Local clock for playhead interpolation & offline detection
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Sessions list extraction
  const sessions = media?.sessions && media.sessions.length > 0
    ? media.sessions
    : (media?.active ? [{
        sessionId: "default",
        app: media.app || "Media",
        title: media.title || "Unknown title",
        artist: media.artist || "",
        isPlaying: !!media.isPlaying,
        positionMs: media.positionMs || 0,
        durationMs: media.durationMs || 0,
        artwork: media.artwork || null,
        isCurrent: true,
      }] : []);

  // Extract accent color from active artwork
  const primaryArtwork = sessions.find((s) => s.artwork)?.artwork || media?.artwork;
  useEffect(() => {
    if (primaryArtwork) {
      extractAccentColor(primaryArtwork).then((c) => {
        if (c) setAccent(c);
      });
    } else {
      setAccent("#6c8ef2");
    }
  }, [primaryArtwork]);

  const sendCommand = useCallback((action, value, sessionId) => {
    if (!channelRef.current) return;
    channelRef.current.send({
      type: "broadcast",
      event: COMMAND_EVENT,
      payload: { action, value, sessionId },
    });
  }, []);

  const sendVolumeDebounced = useCallback(
    (val) => {
      clearTimeout(volDebounceRef.current);
      volDebounceRef.current = setTimeout(() => {
        sendCommand("volume", val);
      }, 150);
    },
    [sendCommand]
  );

  const isOffline = !media || now - lastSeenAt > OFFLINE_AFTER_MS;
  const hasSessions = sessions.length > 0 && !isOffline;

  // Optimistic toggle
  const handleToggle = (session) => {
    const nextIsPlaying = !session.isPlaying;
    setMedia((prev) => {
      if (!prev) return prev;
      const updated = (prev.sessions || []).map((s) =>
        s.sessionId === session.sessionId ? { ...s, isPlaying: nextIsPlaying } : s
      );
      return {
        ...prev,
        sessions: updated,
        isPlaying: session.isCurrent ? nextIsPlaying : prev.isPlaying,
      };
    });
    sendCommand("toggle", null, session.sessionId);
  };

  const handleSeekChange = (sessionId, val) => {
    setDragPositions((prev) => ({ ...prev, [sessionId]: val }));
  };

  const handleSeekEnd = (sessionId, durationMs, val) => {
    const fraction = durationMs > 0 ? val / durationMs : 0;
    sendCommand("seek", fraction, sessionId);
    setTimeout(() => {
      setDragPositions((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }, 400);
  };

  return (
    <div className="screen" style={{ "--accent": accent }}>
      {hasSessions && primaryArtwork && (
        <div
          className="backdrop"
          style={{ backgroundImage: `url(${primaryArtwork})` }}
          aria-hidden="true"
        />
      )}
      {hasSessions && !primaryArtwork && <div className="backdrop" aria-hidden="true" />}

      {/* Top Header */}
      <header className="status" role="status" aria-live="polite">
        <span className={`statusDot ${isOffline ? "offline" : ""}`} />
        <span>
          {configError
            ? "Configuration Error"
            : isOffline
            ? "Waiting for your laptop…"
            : sessions.length > 1
            ? `Live • ${sessions.length} Players Active`
            : "Live • Connected"}
        </span>
      </header>

      {/* Main Content */}
      <main className="body" id="main-content">
        {configError ? (
          <div className="placeholder">
            <h1>Can't connect yet</h1>
            <p>{configError}</p>
          </div>
        ) : !hasSessions ? (
          <div className="placeholder">
            <h1>Nothing playing</h1>
            <p>Start audio or video on your laptop (YouTube, Spotify, etc.) and it will show up here.</p>
          </div>
        ) : (
          <div className={`playersContainer ${sessions.length > 1 ? "multiPlayer" : "singlePlayer"}`}>
            {sessions.map((s, idx) => {
              const elapsed = s.isPlaying && !isOffline ? now - lastSeenAt : 0;
              const curPos =
                dragPositions[s.sessionId] !== undefined
                  ? dragPositions[s.sessionId]
                  : Math.min(s.durationMs || Infinity, (s.positionMs || 0) + elapsed);
              const totalDuration = s.durationMs || 0;

              return (
                <article
                  key={s.sessionId || idx}
                  className={`playerCard ${s.isPlaying ? "cardPlaying" : "cardPaused"}`}
                  aria-label={`${s.title} on ${s.app}`}
                >
                  {/* Card Header: App Badge & Play State */}
                  <div className="cardHeader">
                    <span className="appBadge">{s.app}</span>
                    <span className={`statusBadge ${s.isPlaying ? "badgePlaying" : "badgePaused"}`}>
                      <span className="badgeDot" />
                      {s.isPlaying ? "Playing" : "Paused"}
                    </span>
                  </div>

                  {/* Artwork & Metadata */}
                  <div className="cardMain">
                    <div
                      className="cardArtwork"
                      role="img"
                      aria-label={s.title ? `${s.title} artwork` : "Media artwork"}
                      style={s.artwork ? { backgroundImage: `url(${s.artwork})` } : {}}
                    >
                      {!s.artwork && <MediaIcon />}
                    </div>
                    <div className="cardMeta">
                      <h2 className="cardTitle" title={s.title}>
                        {s.title || "Unknown title"}
                      </h2>
                      <p className="cardArtist" title={s.artist}>
                        {s.artist || "Unknown artist"}
                      </p>
                    </div>
                  </div>

                  {/* Seek Bar */}
                  <div className="progress">
                    <input
                      className="progressBar"
                      type="range"
                      aria-label={`Playback position for ${s.title}`}
                      min={0}
                      max={totalDuration || 1}
                      value={Math.min(curPos, totalDuration || 1)}
                      onChange={(e) => handleSeekChange(s.sessionId, Number(e.target.value))}
                      onMouseUp={(e) => handleSeekEnd(s.sessionId, totalDuration, Number(e.target.value))}
                      onTouchEnd={(e) => handleSeekEnd(s.sessionId, totalDuration, Number(e.target.value))}
                    />
                    <div className="times">
                      <span>{formatTime(curPos)}</span>
                      <span>{formatTime(totalDuration)}</span>
                    </div>
                  </div>

                  {/* Transport Controls */}
                  <section className="cardTransport" aria-label={`Controls for ${s.title}`}>
                    <button
                      className="iconBtn"
                      onClick={() => sendCommand("previous", null, s.sessionId)}
                      aria-label="Previous track"
                    >
                      <PrevIcon size={sessions.length > 1 ? 20 : 24} />
                    </button>

                    <button
                      className={`playBtn ${sessions.length > 1 ? "playBtnCompact" : ""}`}
                      onClick={() => handleToggle(s)}
                      aria-label={s.isPlaying ? "Pause" : "Play"}
                    >
                      {s.isPlaying ? (
                        <PauseIcon size={sessions.length > 1 ? 22 : 26} />
                      ) : (
                        <PlayIcon size={sessions.length > 1 ? 22 : 26} />
                      )}
                    </button>

                    <button
                      className="iconBtn"
                      onClick={() => sendCommand("next", null, s.sessionId)}
                      aria-label="Next track"
                    >
                      <NextIcon size={sessions.length > 1 ? 20 : 24} />
                    </button>
                  </section>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Persistent Master Volume Bar */}
      {hasSessions && (
        <footer className="masterVolumeFooter" role="contentinfo" aria-label="System Master Volume">
          <section className="volumeRow" aria-label="Master volume controls">
            <button
              className="iconBtn"
              onClick={() => sendCommand("mute", !media.muted)}
              aria-label={media.muted ? "Unmute master audio" : "Mute master audio"}
            >
              <VolumeIcon muted={media.muted} />
            </button>
            <input
              className="volumeSlider"
              type="range"
              aria-label="Master volume slider"
              min={0}
              max={100}
              value={Math.round((media.volume ?? 0) * 100)}
              onChange={(e) => sendVolumeDebounced(Number(e.target.value) / 100)}
            />
            <span className="volumePercent">
              {media.muted ? "Muted" : `${Math.round((media.volume ?? 0) * 100)}%`}
            </span>
          </section>
        </footer>
      )}
    </div>
  );
}
