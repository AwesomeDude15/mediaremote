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
  1. SILENT: no console windows, no popups/toast/balloon notifications,
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)

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
    if hasattr(speakers, "EndpointVolume"):
        return speakers.EndpointVolume
    if hasattr(speakers, "_dev"):
        interface = speakers._dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        return interface.QueryInterface(IAudioEndpointVolume)
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


_last_thumb_key = None
_cached_artwork = None

async def _read_thumbnail(thumb_ref):
    """thumb_ref is a RandomAccessStreamReference; returns data_uri or None."""
    if thumb_ref is None:
        return None
    try:
        stream = await asyncio.wait_for(thumb_ref.open_read_async(), timeout=1.0)
        size = stream.size
        if size == 0 or size > MAX_ARTWORK_BYTES:
            return None
        buffer = Buffer(size)
        await asyncio.wait_for(
            stream.read_async(buffer, size, InputStreamOptions.READ_AHEAD),
            timeout=1.0,
        )
        reader = DataReader.from_buffer(buffer)
        raw = bytearray(size)
        reader.read_bytes(raw)
        content_type = getattr(stream, "content_type", None) or "image/png"
        b64 = base64.b64encode(bytes(raw)).decode("ascii")
        return f"data:{content_type};base64,{b64}"
    except Exception:
        return None


async def _get_artwork(props):
    global _last_thumb_key, _cached_artwork
    if not props:
        return None
    thumb_key = (getattr(props, "title", "") or "", getattr(props, "artist", "") or "")
    if thumb_key == _last_thumb_key:
        return _cached_artwork
    _last_thumb_key = thumb_key
    _cached_artwork = await _read_thumbnail(props.thumbnail)
    return _cached_artwork


async def _find_session(manager, session_id: str = None):
    try:
        sessions = manager.get_sessions()
        if session_id:
            for idx, s in enumerate(sessions):
                sid = f"{s.source_app_user_model_id}_{idx}"
                if sid == session_id or s.source_app_user_model_id == session_id:
                    return s
        return manager.get_current_session()
    except Exception:
        return None


async def read_media_state():
    """Returns a dict describing all active and paused media sessions."""
    try:
        manager = await _get_manager()
        sessions = manager.get_sessions()
        current = manager.get_current_session()
        current_id = current.source_app_user_model_id if current else None

        session_list = []
        for idx, s in enumerate(sessions):
            try:
                props = await s.try_get_media_properties_async()
                title = (props.title if props else "") or ""
                artist = (props.artist if props else "") or ""
                app_id = s.source_app_user_model_id or "Media"

                if not title and not s.source_app_user_model_id:
                    continue

                playback_info = s.get_playback_info()
                timeline = s.get_timeline_properties()

                status = int(playback_info.playback_status) if playback_info else 0
                is_playing = status == 4

                position_ms = (
                    int(timeline.position.total_seconds() * 1000)
                    if (timeline and timeline.position)
                    else 0
                )
                duration_ms = (
                    int(timeline.end_time.total_seconds() * 1000)
                    if (timeline and timeline.end_time)
                    else 0
                )

                artwork = await _get_artwork(props)

                session_list.append(
                    {
                        "id": f"{app_id}_{idx}",
                        "sessionId": f"{app_id}_{idx}",
                        "app": app_id,
                        "title": title or "Unknown title",
                        "artist": artist or "",
                        "isPlaying": is_playing,
                        "status": status,
                        "positionMs": max(0, position_ms),
                        "durationMs": max(0, duration_ms),
                        "artwork": artwork,
                        "isCurrent": (s.source_app_user_model_id == current_id)
                        if current_id
                        else False,
                    }
                )
            except Exception:
                continue

        # Sort: playing sessions first, then current session, then paused sessions
        session_list.sort(key=lambda s: (not s["isPlaying"], not s["isCurrent"]))

        primary = session_list[0] if session_list else None
        return {
            "active": len(session_list) > 0,
            "sessions": session_list,
            # Top-level backwards compatibility fields
            "title": primary["title"] if primary else "",
            "artist": primary["artist"] if primary else "",
            "app": primary["app"] if primary else "",
            "isPlaying": primary["isPlaying"] if primary else False,
            "positionMs": primary["positionMs"] if primary else 0,
            "durationMs": primary["durationMs"] if primary else 0,
            "artwork": primary["artwork"] if primary else None,
        }
    except Exception:
        return {"active": False, "sessions": []}


async def apply_command(action: str, value, session_id: str = None):
    try:
        if action == "volume":
            set_system_volume(value)
            return
        elif action == "mute":
            set_system_mute(bool(value))
            return

        manager = await _get_manager()
        session = await _find_session(manager, session_id)

        if action in ("play", "pause", "toggle", "next", "previous", "seek") and session is None:
            return

        if action == "play":
            await session.try_play_async()
        elif action == "pause":
            await session.try_pause_async()
        elif action == "toggle":
            info = session.get_playback_info()
            status = int(info.playback_status) if info else 0
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
            if timeline and timeline.end_time:
                duration_ticks = int(timeline.end_time.total_seconds() * 10_000_000)
                fraction = max(0.0, min(1.0, float(value)))
                target_ticks = int(duration_ticks * fraction)
                await session.try_change_playback_position_async(target_ticks)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Realtime glue
# ---------------------------------------------------------------------------

def build_state_payload(media, vol):
    payload = dict(media)
    payload["volume"] = vol.get("volume")
    payload["muted"] = vol.get("muted")
    payload["ts"] = time.time()
    return payload


def _get_comparable(state):
    comp = {k: v for k, v in state.items() if k not in ("ts", "positionMs", "sessions")}
    comp["sessions"] = [
        {k: v for k, v in s.items() if k not in ("positionMs",)}
        for s in state.get("sessions", [])
    ]
    return comp


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
                session_id = data.get("sessionId")
                asyncio.create_task(apply_command(action, value, session_id))
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

                comparable = _get_comparable(state)
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
    except BaseException as e:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "crash.log"), "w") as f:
            traceback.print_exc(file=f)
