"""
main.py — OmniShare v1 Backend

FastAPI application providing real-time clipboard synchronization and file
sharing across devices on the same local network.  Served over self-signed
HTTPS so the Web Clipboard API works on iOS Safari.

Key architectural decisions:
  • Background threads started inside the @asynccontextmanager lifespan
    (not before uvicorn.run) for clean shutdown signal propagation.
  • DELETE /api/files/all registered BEFORE DELETE /api/files/{filename}
    to avoid FastAPI interpreting "all" as a filename.
  • _last_clipboard is updated BEFORE pyperclip.copy() to prevent the
    clipboard monitor from re-detecting device-originated text.
  • Path-traversal protection on all file endpoints.
"""

import os
import re
import sys
import time
import uuid
import random
import base64
import asyncio
import threading
import collections
from pathlib import Path
from io import BytesIO
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pyperclip
import qrcode
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    UploadFile,
    File,
    Request,
    Response,
    HTTPException,
)
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from starlette.websockets import WebSocketState

from cert_gen import get_local_ip, ensure_certs

# ─── Configuration ────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
CERTS_DIR = BASE_DIR / "certs"
STATIC_DIR = BASE_DIR / "static"
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB
CLEANUP_INTERVAL = 600  # 10 minutes
FILE_MAX_AGE = 86400  # 24 hours
CLIPBOARD_HISTORY_SIZE = 20
PORT = 8000

# ─── Shared State ─────────────────────────────────────────────────────
LOCAL_IP = get_local_ip()
PIN = f"{random.randint(0, 9999):04d}"

sessions: set = set()
clipboard_history: collections.deque = collections.deque(maxlen=CLIPBOARD_HISTORY_SIZE)
connected_websockets: set = set()

shutdown_event = threading.Event()

# Clipboard tracking — prevents the monitor from re-detecting text
# that was just set by a remote device.
_last_clipboard: str = ""
_clipboard_lock = threading.Lock()

# Event-loop reference, set during lifespan startup.
_loop: asyncio.AbstractEventLoop | None = None


# ─── Async Broadcast ──────────────────────────────────────────────────
async def broadcast(message: dict, *, exclude: WebSocket | None = None):
    """Send *message* as JSON to every connected WebSocket client."""
    dead: set = set()
    for ws in connected_websockets:
        if ws is exclude:
            continue
        try:
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_json(message)
        except Exception:
            dead.add(ws)
    connected_websockets.difference_update(dead)


def schedule_broadcast(message: dict, *, exclude: WebSocket | None = None):
    """Thread-safe wrapper: schedule *broadcast* on the ASGI event loop."""
    if _loop is not None and _loop.is_running():
        asyncio.run_coroutine_threadsafe(
            broadcast(message, exclude=exclude), _loop
        )


# ─── Background Threads ──────────────────────────────────────────────
def clipboard_monitor():
    """Poll the Windows system clipboard every 1 s, broadcasting changes."""
    global _last_clipboard
    try:
        with _clipboard_lock:
            _last_clipboard = pyperclip.paste() or ""
    except Exception:
        pass

    while not shutdown_event.is_set():
        try:
            current = pyperclip.paste() or ""
            with _clipboard_lock:
                if current != _last_clipboard and current.strip():
                    _last_clipboard = current
                    entry = {
                        "text": current,
                        "source": "pc",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    clipboard_history.appendleft(entry)
                    schedule_broadcast(
                        {
                            "type": "clipboard_update",
                            "entry": entry,
                            "history": list(clipboard_history),
                        }
                    )
        except Exception:
            pass
        shutdown_event.wait(1.0)


def file_cleanup():
    """Delete files older than 24 h from uploads/, runs every 10 min."""
    while not shutdown_event.is_set():
        try:
            if UPLOAD_DIR.exists():
                now = time.time()
                for f in UPLOAD_DIR.iterdir():
                    if f.is_file() and (now - f.stat().st_mtime) > FILE_MAX_AGE:
                        f.unlink()
                        print(f"  [CLEANUP] Deleted expired file: {f.name}")
        except Exception:
            pass
        shutdown_event.wait(CLEANUP_INTERVAL)


# ─── Path Safety ──────────────────────────────────────────────────────
def safe_file_path(filename: str) -> Path:
    """Resolve *filename* within UPLOAD_DIR; reject path-traversal."""
    # Strip any directory components and dangerous characters
    clean = re.sub(r'[\\/:*?"<>|]', "_", filename)
    file_path = (UPLOAD_DIR / clean).resolve()
    if not str(file_path).startswith(str(UPLOAD_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid filename")
    return file_path


# ─── Lifespan ─────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()

    # Create the uploads directory
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    # Write PIN to file for automated testing / external tools
    (BASE_DIR / "pin.txt").write_text(PIN)

    # Start background daemon threads
    clip_thread = threading.Thread(
        target=clipboard_monitor, daemon=True, name="clipboard-monitor"
    )
    cleanup_thread = threading.Thread(
        target=file_cleanup, daemon=True, name="file-cleanup"
    )
    clip_thread.start()
    cleanup_thread.start()

    print(f"\n{'=' * 60}")
    print(f"  [*] OmniShare v1 is running!")
    print(f"{'=' * 60}")
    print(f"  Local URL   : https://localhost:{PORT}")
    print(f"  Network URL : https://{LOCAL_IP}:{PORT}")
    print(f"  PIN         : {PIN}")
    print(f"{'=' * 60}")
    print()
    print("  [iOS] Safari -- How to accept the self-signed certificate:")
    print(f"     1. Open Safari and go to  https://{LOCAL_IP}:{PORT}")
    print("     2. On the warning page, tap  'Show Details'")
    print("     3. Tap  'visit this website'")
    print("     4. Confirm in the popup, and enter your device")
    print("        passcode if prompted.")
    print(f"\n{'=' * 60}\n")

    yield  # ── app is running ──

    # Shutdown
    print("\n  [SHUTDOWN] Stopping background threads...")
    shutdown_event.set()


# ─── FastAPI App ──────────────────────────────────────────────────────
app = FastAPI(title="OmniShare", lifespan=lifespan)


# ─── Auth Helpers ─────────────────────────────────────────────────────
def verify_session(request: Request) -> bool:
    token = request.cookies.get("omnishare_session")
    return token in sessions


def require_auth(request: Request):
    if not verify_session(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Auth Endpoints ──────────────────────────────────────────────────
@app.post("/api/auth")
async def auth(request: Request, response: Response):
    body = await request.json()
    if body.get("pin") == PIN:
        token = str(uuid.uuid4())
        sessions.add(token)
        response.set_cookie(
            key="omnishare_session",
            value=token,
            httponly=True,
            secure=True,
            samesite="lax",
            max_age=86400,
        )
        return {"status": "ok"}
    raise HTTPException(status_code=403, detail="Invalid PIN")


@app.get("/api/auth/status")
async def auth_status(request: Request):
    if verify_session(request):
        return {"authenticated": True}
    raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Network Info ─────────────────────────────────────────────────────
@app.get("/api/network-info")
async def network_info(request: Request):
    require_auth(request)
    client_host = request.client.host if request.client else ""
    is_local = client_host in ("127.0.0.1", "::1", "localhost")
    data: dict = {"ip": LOCAL_IP, "port": PORT}
    if is_local:
        data["pin"] = PIN
    return data


# ─── QR Code (generated server-side, zero frontend deps) ─────────────
@app.get("/api/qr")
async def qr_code_endpoint(request: Request):
    require_auth(request)
    url = f"https://{LOCAL_IP}:{PORT}"
    img = qrcode.make(url)
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return {"qr": f"data:image/png;base64,{b64}", "url": url}


# ─── Clipboard ────────────────────────────────────────────────────────
@app.get("/api/clipboard")
async def get_clipboard(request: Request):
    require_auth(request)
    return {"history": list(clipboard_history)}


@app.post("/api/clipboard")
async def post_clipboard(request: Request):
    global _last_clipboard
    require_auth(request)
    body = await request.json()
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty clipboard text")

    # Update tracking var FIRST to prevent monitor from re-detecting
    with _clipboard_lock:
        _last_clipboard = text
    pyperclip.copy(text)

    entry = {
        "text": text,
        "source": "device",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    clipboard_history.appendleft(entry)

    await broadcast(
        {"type": "clipboard_update", "entry": entry, "history": list(clipboard_history)}
    )
    return {"status": "ok"}


# ─── File Upload ──────────────────────────────────────────────────────
@app.post("/api/upload")
async def upload_file(request: Request, file: UploadFile = File(...)):
    require_auth(request)

    # Early check via Content-Length header
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413, detail="File too large. Maximum size is 500 MB."
        )

    # Sanitise the filename
    safe_name = re.sub(r'[\\/:*?"<>|]', "_", file.filename or "upload")
    if not safe_name:
        safe_name = "upload"
    file_path = UPLOAD_DIR / safe_name

    # Stream to disk, enforcing the size cap chunk-by-chunk
    total_size = 0
    try:
        with open(file_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):  # 1 MB
                total_size += len(chunk)
                if total_size > MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail="File too large. Maximum size is 500 MB.",
                    )
                f.write(chunk)
    except HTTPException:
        file_path.unlink(missing_ok=True)
        raise

    await broadcast({"type": "files_updated"})
    return {"status": "ok", "filename": safe_name, "size": total_size}


# ─── File Listing ─────────────────────────────────────────────────────
@app.get("/api/files")
async def list_files(request: Request):
    require_auth(request)
    files = []
    if UPLOAD_DIR.exists():
        for f in sorted(
            UPLOAD_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            if f.is_file():
                stat = f.stat()
                files.append(
                    {
                        "name": f.name,
                        "size": stat.st_size,
                        "modified": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(),
                    }
                )
    return {"files": files}


# ─── Storage ──────────────────────────────────────────────────────────
@app.get("/api/storage")
async def storage_info(request: Request):
    require_auth(request)
    total = 0
    if UPLOAD_DIR.exists():
        for f in UPLOAD_DIR.iterdir():
            if f.is_file():
                total += f.stat().st_size
    return {"used_bytes": total}


# ─── File Deletion ────────────────────────────────────────────────────
# ⚠ ORDER MATTERS: /all MUST come before /{filename}
@app.delete("/api/files/all")
async def delete_all_files(request: Request):
    require_auth(request)
    if UPLOAD_DIR.exists():
        for f in UPLOAD_DIR.iterdir():
            if f.is_file():
                f.unlink()
    await broadcast({"type": "files_updated"})
    return {"status": "ok"}


@app.delete("/api/files/{filename:path}")
async def delete_file(filename: str, request: Request):
    require_auth(request)
    file_path = safe_file_path(filename)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    file_path.unlink()
    await broadcast({"type": "files_updated"})
    return {"status": "ok"}


# ─── File Download ────────────────────────────────────────────────────
@app.get("/api/files/{filename:path}")
async def download_file(filename: str, request: Request):
    require_auth(request)
    file_path = safe_file_path(filename)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path, filename=file_path.name)


# ─── WebSocket ────────────────────────────────────────────────────────
@app.websocket("/api/ws")
async def websocket_endpoint(ws: WebSocket):
    global _last_clipboard

    # Authenticate via session cookie
    token = ws.cookies.get("omnishare_session")
    if token not in sessions:
        await ws.close(code=4001, reason="Unauthorized")
        return

    await ws.accept()
    connected_websockets.add(ws)

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "clipboard_update":
                text = data.get("text", "").strip()
                if text:
                    # Update tracking var FIRST
                    with _clipboard_lock:
                        _last_clipboard = text
                    pyperclip.copy(text)

                    entry = {
                        "text": text,
                        "source": "device",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    clipboard_history.appendleft(entry)

                    # Broadcast to OTHER connected clients
                    await broadcast(
                        {
                            "type": "clipboard_update",
                            "entry": entry,
                            "history": list(clipboard_history),
                        },
                        exclude=ws,
                    )
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        connected_websockets.discard(ws)


# ─── Static Files (mount LAST so API routes take precedence) ──────────
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# ─── Entry Point ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    # Pre-flight: ensure TLS certs exist (needed by uvicorn at bind time)
    cert_file, key_file = ensure_certs(str(CERTS_DIR), LOCAL_IP)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        ssl_keyfile=key_file,
        ssl_certfile=cert_file,
        log_level="info",
    )
