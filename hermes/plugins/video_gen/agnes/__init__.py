"""Agnes AI video generation — text-to-video, image-to-video and reference-to-video.

``POST <base>/v1/videos`` takes a ``mode``, and the mode decides which media fields are legal:

===============  ======================================  ==========================================
``mode``         requires                                forbids
===============  ======================================  ==========================================
``text``         nothing                                 ``first_frame``, ``last_frame``, ``images``,
                                                         ``audios``, ``videos``
``keyframe``     ``first_frame`` and/or ``last_frame``   ``images``, ``audios``, ``videos``
``reference``    a non-empty ``images`` or ``audios``    ``first_frame``, ``last_frame``, ``videos``
===============  ======================================  ==========================================

Flash limits: ``images`` <= 5, ``audios`` <= 3, non-empty ``videos`` is a 400. ``seconds`` 4-12,
``size`` ``720P`` (720x1280 at 9:16), ``aspect_ratio`` one of :data:`ASPECT_RATIOS`.

Three behaviours shape this provider. All three were measured, and each one looks like a broken
API if you have not seen it before:

1. **Reference URLs expire.** A URL returned by ``/v1/images/generations`` is public when it is
   created and gone later — measured as ``404`` with an XML ``NoSuchKey`` body about 40 minutes
   on. Submitting a stale one is *accepted*, and then fails with
   ``{"status": "failed", "error": {"code": "media_download_failed"}}``. So every http(s)
   reference is fetched and checked for an image content type *immediately before each submit
   attempt* — the payload is rebuilt on every retry for exactly this reason — and a local path is
   inlined as a data URI instead.
2. **A task is visible only to the key that submitted it.** Polling the same ``video_id`` with
   thirteen sibling keys answered ``404 task not found`` every time while the submitting key
   answered ``200``. The submitting key is therefore carried into the poll. Without that, a
   rotating key pool makes a healthy endpoint look dead.
3. **The queue is the bottleneck, not the account count.** ``503 video_queue_full`` arrives on
   every key at the same instant and can persist for 40+ consecutive attempts; extra keys do not
   add render slots. The submit is retried against a wall-clock deadline instead of an attempt cap.

``progress`` is never consulted as a success signal: a failed task reports ``progress: 100``.
Only ``status`` decides.

Keys come from ``AGNES_API_KEYS`` (comma/space separated) or ``AGNES_API_KEY``.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from agent.video_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    DEFAULT_RESOLUTION,
    VideoGenProvider,
    error_response,
    save_url_video,
    success_response,
)

logger = logging.getLogger(__name__)

PROVIDER_ID = "agnes"
BASE_URL = "https://apihub.agnes-ai.com"
DEFAULT_MODEL = "agnes-video-2.5-flash"

MODELS: Dict[str, Dict[str, Any]] = {
    "agnes-video-2.5-flash": {
        "display": "Agnes Video 2.5 Flash",
        "speed": "fast",
        "strengths": ["text-to-video", "reference-to-video", "keyframe"],
        "modalities": ["text", "image"],
    },
    "agnes-video-2.5": {
        "display": "Agnes Video 2.5",
        "speed": "quality",
        "strengths": ["text-to-video", "reference-to-video"],
        "modalities": ["text", "image"],
    },
}

ASPECT_RATIOS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
RESOLUTIONS = ("720p",)
# The API spells the size in upper case; the tool speaks "720p".
SIZE_FOR_RESOLUTION = {"720p": "720P", "720": "720P", "480p": "720P", "1080p": "720P"}

SECONDS_MIN, SECONDS_MAX = 4, 12
MAX_REFERENCE_IMAGES = 5
MAX_REFERENCE_AUDIOS = 3

_POLL_INTERVAL = 27.0        # faster than ~20s triggers "too many video status queries"
_QUEUE_RETRY_SLEEP = 30.0    # 503 video_queue_full is capacity, not a malformed request
_QUEUE_DEADLINE = 900.0      # give the queue a real chance, then report honestly
_RENDER_DEADLINE = 1200.0
_HTTP_TIMEOUT = 120.0

try:  # present in every Hermes runtime; the fallbacks keep the plugin importable standalone
    from agent.secret_scope import get_secret_str as _get_secret_str
except Exception:  # noqa: BLE001
    _get_secret_str = None  # type: ignore[assignment]


# --------------------------------------------------------------------------- secrets


def _secret(*names: str) -> str:
    """First non-empty value from the secret scope, the environment, then ``$HERMES_HOME/.env``."""
    for name in names:
        if _get_secret_str is not None:
            try:
                value = _get_secret_str(name)
                if value:
                    return str(value).strip()
            except Exception:  # noqa: BLE001
                pass
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    home = os.environ.get("HERMES_HOME", "/opt/data")
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() in names:
                    return value.strip().strip('"').strip("'")
    except Exception:  # noqa: BLE001
        pass
    return ""


def _keys() -> List[str]:
    raw = _secret("AGNES_API_KEYS", "AGNES_API_KEY")
    return [k for k in re.split(r"[,;\s]+", raw) if k]


# --------------------------------------------------------------------------- http


def _request(method: str, url: str, key: str = "", payload: Optional[dict] = None,
             timeout: float = _HTTP_TIMEOUT) -> Tuple[Any, bytes]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(4000)
    except Exception as exc:  # noqa: BLE001
        return "ERR", str(exc).encode()


_IMAGE_MAGIC: Tuple[Tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
)


def _sniff_mime(raw: bytes) -> str:
    """Real media type from the bytes: generated files lie about their extension."""
    for magic, mime in _IMAGE_MAGIC:
        if raw.startswith(magic):
            return mime
    if raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _verify_url(url: str, timeout: float = 25.0) -> Tuple[bool, str]:
    """Fetch ``url`` and insist on an image content type.

    A stale provider URL (404) and a host that answers an HTML wrapper page both fail inside the
    renderer with ``media_download_failed``; catching them here turns that into an actionable
    message instead of a mysterious job failure.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.14.1", "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            if resp.status == 200 and (not ctype or ctype.startswith("image/")):
                return True, f"200 {ctype or 'image/*'}"
            return False, f"{resp.status} {ctype or 'unknown content-type'}"
    except urllib.error.HTTPError as exc:
        return False, f"{exc.code} {exc.reason}"
    except Exception as exc:  # noqa: BLE001
        # Cloudflare-style guards reject urllib's fingerprint but accept curl.
        try:
            proc = subprocess.run(
                ["curl", "-sSL", "-m", str(int(timeout)), "-o", "/dev/null",
                 "-w", "%{http_code} %{content_type}", url],
                capture_output=True, text=True, timeout=timeout + 20,
            )
            info = (proc.stdout or "").strip()
            return info.startswith("200"), info or str(exc)[:120]
        except Exception as curl_exc:  # noqa: BLE001
            return False, f"{exc} / curl: {curl_exc}"


def _prepare_reference(value: str) -> Tuple[Optional[str], str]:
    """Return ``(usable_reference, note)`` for one caller-supplied reference."""
    text = str(value).strip()
    if not text:
        return None, "empty"
    if text.startswith("data:"):
        return text, "data-uri inline"
    if text.startswith(("http://", "https://")):
        ok, info = _verify_url(text)
        if ok:
            return text, f"url ok ({info})"
        return None, f"url not fetchable now ({info})"
    path = Path(text)
    if path.exists():
        try:
            raw = path.read_bytes()
            return "data:%s;base64,%s" % (_sniff_mime(raw), base64.b64encode(raw).decode()), \
                "local file inlined"
        except Exception as exc:  # noqa: BLE001
            return None, f"unreadable local file ({exc})"
    return None, "neither a URL nor a readable path"


# --------------------------------------------------------------------------- submit / poll


def _submit(factory: Callable[[], Tuple[Optional[dict], List[str]]], keys: List[str],
            deadline: float) -> Tuple[Optional[str], str, List[str]]:
    """Post the job, rebuilding the payload on every attempt.

    References are re-verified per attempt on purpose: a queue wait can outlive the URL.
    Returns ``(video_id, submitting_key, errors)``.
    """
    errors: List[str] = []
    index = 0
    end = time.time() + deadline
    while time.time() < end:
        payload, notes = factory()
        if payload is None:
            return None, "", errors + ["source media unusable: " + "; ".join(notes)]
        key = keys[index % len(keys)]
        index += 1
        code, body = _request("POST", f"{BASE_URL}/v1/videos", key, payload)
        text = body.decode("utf-8", "replace")
        if code == 200:
            try:
                video_id = json.loads(text).get("video_id")
            except Exception:  # noqa: BLE001
                video_id = None
            if video_id:
                return str(video_id), key, errors
            errors.append(f"accepted without a video_id: {text[:200]}")
        elif code == 503 and "video_queue_full" in text:
            errors.append("queue full")
        elif code in (429, 500, 502, 504):
            errors.append(f"{code}: {text[:150]}")
        else:
            # 400 / 401 / 403 are the request's fault; retrying only wastes the deadline.
            return None, "", errors + [f"{code}: {text[:400]}"]
        if time.time() + _QUEUE_RETRY_SLEEP >= end:
            break
        time.sleep(_QUEUE_RETRY_SLEEP)
    return None, "", errors


def _poll(video_id: str, key: str, model: str, deadline: float) -> Dict[str, Any]:
    """Poll with the key that submitted. ``status`` decides; ``progress`` is ignored."""
    end = time.time() + deadline
    last: Dict[str, Any] = {}
    while time.time() < end:
        time.sleep(_POLL_INTERVAL)
        code, body = _request(
            "GET", f"{BASE_URL}/agnesapi?video_id={video_id}&model_name={model}", key, None, 60.0)
        text = body.decode("utf-8", "replace")
        if code == 429:
            continue  # "too many video status queries"
        if code != 200:
            last = {"status": "error",
                    "error": {"code": str(code), "message": text[:200]}}
            continue
        try:
            last = json.loads(text)
        except Exception:  # noqa: BLE001
            continue
        if last.get("status") in ("completed", "failed"):
            return last
    return last or {"status": "timeout",
                    "error": {"code": "poll_timeout",
                              "message": f"no terminal status within {int(deadline)}s"}}


# --------------------------------------------------------------------------- provider


class AgnesVideoGenProvider(VideoGenProvider):
    """Agnes AI video backend: text, keyframe (image-to-video) and reference modes."""

    name = PROVIDER_ID
    display_name = "Agnes AI"

    def is_available(self) -> bool:
        return bool(_keys())

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": model_id, **meta} for model_id, meta in MODELS.items()]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Agnes AI video",
            "badge": "free",
            "tag": ("agnes-video-2.5-flash (text / keyframe / reference, 4-12s, 720P, up to 5 "
                    "reference images). Reference URLs must be fetchable at submit time — the "
                    "provider's own output URLs expire, so generate and submit back to back."),
            "env_vars": [{"name": "AGNES_API_KEYS", "label": "Agnes keys (comma separated)"}],
            "post_setup": "",
        }

    def capabilities(self) -> Dict[str, Any]:
        return {
            "modalities": ["text", "image"],
            "aspect_ratios": list(ASPECT_RATIOS),
            "resolutions": list(RESOLUTIONS),
            "max_duration": SECONDS_MAX,
            "min_duration": SECONDS_MIN,
            "supports_audio": False,
            "supports_negative_prompt": False,
            "supports_seed": False,
            "supports_upscale": False,
            "max_reference_images": MAX_REFERENCE_IMAGES,
        }

    def generate(
        self, prompt: str, *, model: Optional[str] = None, image_url: Optional[str] = None,
        reference_image_urls: Optional[list[str]] = None, duration: Optional[int] = None,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO, resolution: str = DEFAULT_RESOLUTION,
        negative_prompt: Optional[str] = None, audio: Optional[bool] = None,
        seed: Optional[int] = None, **kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        aspect = aspect_ratio if aspect_ratio in ASPECT_RATIOS else DEFAULT_ASPECT_RATIO
        if not prompt:
            return error_response(error="prompt is required", error_type="invalid_request",
                                  provider=PROVIDER_ID, aspect_ratio=aspect)

        keys = _keys()
        if not keys:
            return error_response(error="AGNES_API_KEYS is not configured",
                                  error_type="auth_error", provider=PROVIDER_ID,
                                  prompt=prompt, aspect_ratio=aspect)

        model_id = model if model in MODELS else DEFAULT_MODEL
        size = SIZE_FOR_RESOLUTION.get((resolution or "").lower(), "720P")
        try:
            seconds = int(duration) if duration else SECONDS_MIN
        except (TypeError, ValueError):
            seconds = SECONDS_MIN
        seconds = max(SECONDS_MIN, min(SECONDS_MAX, seconds))

        ref_values = [str(r) for r in (reference_image_urls or []) if r]
        state: Dict[str, Any] = {"mode": "text", "refs": 0}

        def factory() -> Tuple[Optional[dict], List[str]]:
            """Build the payload, re-checking every reference so a queue wait cannot outlive it."""
            notes: List[str] = []
            usable: List[str] = []
            for value in ref_values[:MAX_REFERENCE_IMAGES]:
                ref, note = _prepare_reference(value)
                notes.append(note)
                if ref:
                    usable.append(ref)

            payload: Dict[str, Any] = {
                "model": model_id, "prompt": prompt, "seconds": str(seconds),
                "size": size, "aspect_ratio": aspect,
            }
            if usable:
                payload["mode"] = "reference"
                payload["images"] = usable
                state["mode"], state["refs"] = "reference", len(usable)
                return payload, notes

            if ref_values and not usable:
                # References were requested and none survived verification: rendering an
                # unrelated scene instead would be worse than saying so.
                return None, notes

            if image_url:
                first_frame, note = _prepare_reference(str(image_url))
                notes.append("first_frame: " + note)
                if not first_frame:
                    return None, notes
                payload["mode"] = "keyframe"
                payload["first_frame"] = first_frame
                state["mode"] = "keyframe"
                return payload, notes

            payload["mode"] = "text"
            state["mode"] = "text"
            return payload, notes

        video_id, submit_key, errors = _submit(factory, keys, _QUEUE_DEADLINE)
        if not video_id:
            queue_bound = bool(errors) and all("queue full" in e for e in errors)
            media_bad = any("source media unusable" in e for e in errors)
            if queue_bound:
                message = (f"Agnes video queue stayed full for {int(_QUEUE_DEADLINE)}s "
                           f"across {len(keys)} keys ({len(errors)} attempts)")
            elif media_bad:
                message = next(e for e in errors if "source media unusable" in e)
            else:
                message = "Agnes rejected the job: " + "; ".join(errors[-3:])
            return error_response(
                error=message,
                error_type=("queue_full" if queue_bound
                            else "invalid_request" if media_bad else "provider_error"),
                provider=PROVIDER_ID, model=model_id, prompt=prompt, aspect_ratio=aspect)

        final = _poll(video_id, submit_key, model_id, _RENDER_DEADLINE)
        status = final.get("status")
        if status == "completed" and final.get("url"):
            remote = str(final["url"])
            try:
                video = str(save_url_video(remote, prefix="agnes", timeout=300.0))
            except Exception as exc:  # noqa: BLE001 - hand back the URL rather than fail
                logger.warning("Agnes video download failed, returning the remote URL: %s", exc)
                video = remote
            return success_response(
                video=video, model=model_id, prompt=prompt,
                modality="text" if state["mode"] == "text" else "image",
                aspect_ratio=aspect, duration=seconds, provider=PROVIDER_ID,
                extra={"source": "agnes", "mode": state["mode"],
                       "reference_images": state["refs"], "size": size,
                       "video_id": video_id, "keys_pool": len(keys),
                       "remote_url": remote, "queue_attempts": len(errors),
                       "tried": [{"provider": "agnes", "error": e} for e in errors]})

        error = final.get("error") or {}
        return error_response(
            error=(f"Agnes render {status}: "
                   f"{error.get('code') or ''} {error.get('message') or ''}").strip(),
            error_type="provider_error", provider=PROVIDER_ID, model=model_id,
            prompt=prompt, aspect_ratio=aspect)


def register(ctx) -> None:
    """Plugin entry point — wire :class:`AgnesVideoGenProvider` into the registry."""
    ctx.register_video_gen_provider(AgnesVideoGenProvider())
