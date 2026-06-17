/**
 * app.js — OmniShare v1 Frontend
 *
 * Modules:
 *   • Auth        – PIN login gate with session cookie
 *   • WSManager   – WebSocket lifecycle with Page Visibility API,
 *                   exponential backoff, heartbeat ping/pong
 *   • Clipboard   – Sync via WS, copy-to-device with execCommand fallback
 *   • Files       – Drag-drop upload with XHR progress, list, delete
 *   • QR          – Renders server-generated base64 QR image
 *   • Toasts      – Slide-in/out notification system
 */

"use strict";

/* ═══════════════════════════════════════════════════════════════
   TOAST SYSTEM
   ═══════════════════════════════════════════════════════════════ */
const TOAST_ICONS = { success: "✅", error: "❌", info: "ℹ️" };

function showToast(message, type = "info", durationMs = 3000) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || ""}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("hiding");
        toast.addEventListener("animationend", () => toast.remove());
    }, durationMs);
}


/* ═══════════════════════════════════════════════════════════════
   AUTH MODULE
   ═══════════════════════════════════════════════════════════════ */
const authModal = document.getElementById("auth-modal");
const appEl = document.getElementById("app");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const pinDigits = document.querySelectorAll(".pin-digit");

function getPin() {
    return Array.from(pinDigits).map(d => d.value).join("");
}

// Auto-advance PIN input fields
pinDigits.forEach((input, idx) => {
    input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 1);
        if (input.value && idx < pinDigits.length - 1) {
            pinDigits[idx + 1].focus();
        }
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !input.value && idx > 0) {
            pinDigits[idx - 1].focus();
        }
        if (e.key === "Enter") {
            submitPin();
        }
    });
});

async function submitPin() {
    const pin = getPin();
    if (pin.length !== 4) {
        authError.textContent = "Please enter all 4 digits";
        return;
    }

    authSubmit.disabled = true;
    authError.textContent = "";

    try {
        const res = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin }),
        });
        if (res.ok) {
            authModal.classList.add("hidden");
            appEl.classList.remove("hidden");
            initApp();
        } else {
            authError.textContent = "Wrong PIN — check the host PC console";
            pinDigits.forEach(d => (d.value = ""));
            pinDigits[0].focus();
        }
    } catch (err) {
        authError.textContent = "Connection failed — is the server running?";
    } finally {
        authSubmit.disabled = false;
    }
}

authSubmit.addEventListener("click", submitPin);

// On page load: check if we already have a valid session cookie
async function checkAuth() {
    try {
        const res = await fetch("/api/auth/status");
        if (res.ok) {
            authModal.classList.add("hidden");
            appEl.classList.remove("hidden");
            initApp();
            return;
        }
    } catch { /* fall through to show modal */ }

    authModal.classList.remove("hidden");
    appEl.classList.add("hidden");
    pinDigits[0].focus();
}


/* ═══════════════════════════════════════════════════════════════
   WEBSOCKET MANAGER
   ═══════════════════════════════════════════════════════════════ */
class WSManager {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.intentionallyClosed = false;
    }

    connect() {
        this.cleanup();
        this.intentionallyClosed = false;

        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        this.ws = new WebSocket(`${proto}//${location.host}/api/ws`);

        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            setConnectionStatus(true);
            this.startHeartbeat();
            // Catch up on any state changes that happened while disconnected
            fetchClipboard();
            fetchFiles();
            fetchStorage();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch { /* ignore malformed */ }
        };

        this.ws.onclose = () => {
            setConnectionStatus(false);
            this.stopHeartbeat();
            if (!this.intentionallyClosed && document.visibilityState === "visible") {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = () => { /* onclose will fire */ };
    }

    handleMessage(data) {
        if (data.type === "pong") {
            clearTimeout(this.heartbeatTimeout);
            return;
        }
        if (data.type === "clipboard_update") {
            renderClipboardUpdate(data);
            return;
        }
        if (data.type === "files_updated") {
            fetchFiles();
            fetchStorage();
            return;
        }
    }

    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectAttempts * 2000, 10000);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "ping" }));
                this.heartbeatTimeout = setTimeout(() => {
                    // No pong received — connection is dead
                    if (this.ws) this.ws.close();
                }, 10000);
            }
        }, 25000);
    }

    stopHeartbeat() {
        clearInterval(this.heartbeatInterval);
        clearTimeout(this.heartbeatTimeout);
    }

    cleanup() {
        this.stopHeartbeat();
        clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.intentionallyClosed = true;
            try {
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
            } catch { /* ignore */ }
            this.ws = null;
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}

let wsManager = null;

// Page Visibility API — core iOS Safari resilience pattern
document.addEventListener("visibilitychange", () => {
    if (!wsManager) return;
    if (document.visibilityState === "visible") {
        if (!wsManager.ws || wsManager.ws.readyState !== WebSocket.OPEN) {
            wsManager.connect();
        }
    } else {
        // Page hidden — close socket, stop timers to save battery
        wsManager.cleanup();
        setConnectionStatus(false);
    }
});


/* ═══════════════════════════════════════════════════════════════
   CONNECTION STATUS UI
   ═══════════════════════════════════════════════════════════════ */
function setConnectionStatus(connected) {
    const el = document.getElementById("connection-status");
    const dot = el.querySelector(".status-dot");
    const text = el.querySelector(".status-text");
    dot.className = "status-dot " + (connected ? "connected" : "disconnected");
    text.textContent = connected ? "Connected" : "Disconnected";
}


/* ═══════════════════════════════════════════════════════════════
   CLIPBOARD MODULE
   ═══════════════════════════════════════════════════════════════ */
const clipboardTextarea = document.getElementById("clipboard-text");
const clipboardSummary = document.getElementById("clipboard-summary");
const clipboardEditor = document.getElementById("clipboard-editor");
const historyList = document.getElementById("history-list");
const historyCount = document.getElementById("history-count");
const historyEmpty = document.getElementById("history-empty");

// History Modal elements
const btnHistory = document.getElementById("btn-history");
const historyPanel = document.getElementById("history-panel");
const historyClose = document.getElementById("history-close");
const historyBackdrop = document.getElementById("history-backdrop");

function showClipboardSummary() {
    if (clipboardTextarea.value.trim().length > 0) {
        clipboardSummary.classList.remove("hidden");
        clipboardEditor.classList.add("hidden");
    }
}

function showClipboardEditor() {
    clipboardSummary.classList.add("hidden");
    clipboardEditor.classList.remove("hidden");
}

clipboardSummary.addEventListener("click", () => {
    showClipboardEditor();
    clipboardTextarea.focus();
});

if (btnHistory) {
    btnHistory.addEventListener("click", () => {
        historyPanel.classList.add("active");
        historyBackdrop.classList.add("active");
    });
}

if (historyClose) {
    historyClose.addEventListener("click", () => {
        historyPanel.classList.remove("active");
        historyBackdrop.classList.remove("active");
    });
}

if (historyBackdrop) {
    historyBackdrop.addEventListener("click", () => {
        historyPanel.classList.remove("active");
        historyBackdrop.classList.remove("active");
    });
}

/**
 * Copy text to the device's clipboard.
 * Primary: Clipboard API (requires secure context + user gesture).
 * Fallback: hidden textarea + execCommand for non-secure / older browsers.
 */
async function copyToDeviceClipboard(text) {
    // Attempt the modern Clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            showToast("Copied to clipboard", "success");
            return true;
        } catch (e) {
            console.warn("Clipboard API rejected, using fallback:", e);
        }
    }

    // Fallback: hidden <textarea> + execCommand('copy')
    const ta = document.createElement("textarea");
    ta.value = text;
    // Must be in the viewport (not display:none) for iOS Safari
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();

    let ok = false;
    try {
        ok = document.execCommand("copy");
    } catch { /* ignore */ }

    document.body.removeChild(ta);

    if (ok) {
        showToast("Copied to clipboard", "success");
    } else {
        showToast("Copy failed — try long-pressing to paste manually", "error");
    }
    return ok;
}

// "Copy to Clipboard" button — copies the current textarea content
document.getElementById("btn-copy").addEventListener("click", () => {
    const text = clipboardTextarea.value.trim();
    if (!text) {
        showToast("Nothing to copy", "info");
        return;
    }
    copyToDeviceClipboard(text);
    showClipboardSummary();
});

// "Send to Devices" button — pushes text to the server + PC clipboard
document.getElementById("btn-send").addEventListener("click", () => {
    const text = clipboardTextarea.value.trim();
    if (!text) {
        showToast("Nothing to send", "info");
        return;
    }
    if (wsManager) {
        wsManager.send({ type: "clipboard_update", text });
        showToast("Sent to all devices", "success");
        showClipboardSummary();
    } else {
        // Fallback: REST
        fetch("/api/clipboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        }).then(r => {
            if (r.ok) {
                showToast("Sent to all devices", "success");
                showClipboardSummary();
            }
            else showToast("Send failed", "error");
        }).catch(() => showToast("Send failed", "error"));
    }
});

async function fetchClipboard() {
    try {
        const res = await fetch("/api/clipboard");
        if (!res.ok) return;
        const data = await res.json();
        renderClipboardHistory(data.history);
    } catch { /* ignore */ }
}

function renderClipboardUpdate(data) {
    // Update the main textarea with the latest entry
    if (data.entry) {
        clipboardTextarea.value = data.entry.text;
        showClipboardSummary();
    }
    // Re-render full history
    if (data.history) {
        renderClipboardHistory(data.history);
    }
}

function renderClipboardHistory(history) {
    historyCount.textContent = history.length;

    if (history.length === 0) {
        historyEmpty.style.display = "";
        // Remove all items but keep the empty placeholder
        historyList.querySelectorAll(".history-item").forEach(el => el.remove());
        showClipboardEditor();
        return;
    }

    historyEmpty.style.display = "none";

    // Update the textarea with the most recent entry
    if (history.length > 0) {
        clipboardTextarea.value = history[0].text;
        showClipboardSummary();
    }

    // Rebuild the list
    const fragment = document.createDocumentFragment();
    history.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "history-item";

        const timeStr = formatTime(entry.timestamp);
        const previewText = entry.text.length > 120
            ? entry.text.substring(0, 120) + "…"
            : entry.text;

        item.innerHTML = `
            <div class="history-item-content">
                <div class="history-text" title="${escapeHtml(entry.text)}">${escapeHtml(previewText)}</div>
                <div class="history-meta">
                    <span class="history-source ${entry.source}">${entry.source === "pc" ? "PC" : "Device"}</span>
                    <span class="history-time">${timeStr}</span>
                </div>
            </div>
            <button class="history-copy-btn" title="Copy this text">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
        `;

        // Click the copy button
        const copyBtn = item.querySelector(".history-copy-btn");
        copyBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            copyToDeviceClipboard(entry.text);
        });

        // Click the item itself → fill the textarea & close history modal
        item.addEventListener("click", () => {
            clipboardTextarea.value = entry.text;
            showClipboardEditor();
            if (historyPanel) historyPanel.classList.remove("active");
            if (historyBackdrop) historyBackdrop.classList.remove("active");
        });

        fragment.appendChild(item);
    });

    // Clear old items and append new
    historyList.querySelectorAll(".history-item").forEach(el => el.remove());
    historyList.appendChild(fragment);
}


/* ═══════════════════════════════════════════════════════════════
   FILE MODULE
   ═══════════════════════════════════════════════════════════════ */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileList = document.getElementById("file-list");
const fileEmpty = document.getElementById("file-empty");
const progressBar = document.getElementById("upload-progress");
const progressFill = document.getElementById("upload-progress-fill");
const progressText = document.getElementById("upload-progress-text");
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

// Click dropzone → open file picker
dropzone.addEventListener("click", () => fileInput.click());

// File input change
fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
        Array.from(fileInput.files).forEach(uploadFile);
    }
    fileInput.value = "";
});

// Drag & Drop events
dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
});
dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
        Array.from(e.dataTransfer.files).forEach(uploadFile);
    }
});

// Prevent full-page drag
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

function uploadFile(file) {
    if (file.size > MAX_FILE_SIZE) {
        showToast(`"${file.name}" exceeds the 500 MB limit`, "error");
        return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    // Show progress
    progressBar.classList.add("active");
    progressFill.style.width = "0%";
    progressText.textContent = "0%";

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = pct + "%";
            progressText.textContent = pct + "%";
        }
    };

    xhr.onload = () => {
        progressBar.classList.remove("active");
        progressFill.style.width = "0%";
        if (xhr.status === 200) {
            showToast(`Uploaded "${file.name}"`, "success");
            fetchFiles();
            fetchStorage();
        } else {
            try {
                const resp = JSON.parse(xhr.responseText);
                showToast(resp.detail || "Upload failed", "error");
            } catch {
                showToast("Upload failed", "error");
            }
        }
    };

    xhr.onerror = () => {
        progressBar.classList.remove("active");
        progressFill.style.width = "0%";
        showToast("Upload failed — check connection", "error");
    };

    xhr.send(formData);
}

async function fetchFiles() {
    try {
        const res = await fetch("/api/files");
        if (!res.ok) return;
        const data = await res.json();
        renderFileList(data.files);
    } catch { /* ignore */ }
}

function renderFileList(files) {
    if (files.length === 0) {
        fileEmpty.style.display = "";
        fileList.querySelectorAll(".file-item").forEach(el => el.remove());
        return;
    }

    fileEmpty.style.display = "none";
    const fragment = document.createDocumentFragment();

    files.forEach((file) => {
        const item = document.createElement("div");
        item.className = "file-item";

        const icon = getFileIcon(file.name);
        const size = formatBytes(file.size);
        const time = formatTime(file.modified);

        item.innerHTML = `
            <div class="file-icon">${icon}</div>
            <div class="file-info">
                <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <div class="file-meta">
                    <span>${size}</span>
                    <span>${time}</span>
                </div>
            </div>
            <div class="file-actions">
                <button class="file-action-btn download" title="Download">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button class="file-action-btn delete" title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        `;

        // Download
        item.querySelector(".download").addEventListener("click", (e) => {
            e.stopPropagation();
            const a = document.createElement("a");
            a.href = `/api/files/${encodeURIComponent(file.name)}`;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });

        // Delete
        item.querySelector(".delete").addEventListener("click", (e) => {
            e.stopPropagation();
            deleteFile(file.name);
        });

        fragment.appendChild(item);
    });

    fileList.querySelectorAll(".file-item").forEach(el => el.remove());
    fileList.appendChild(fragment);
}

async function deleteFile(filename) {
    try {
        const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: "DELETE" });
        if (res.ok) {
            showToast(`Deleted "${filename}"`, "info");
            fetchFiles();
            fetchStorage();
        } else {
            showToast("Delete failed", "error");
        }
    } catch {
        showToast("Delete failed", "error");
    }
}

// Clear All Files
document.getElementById("btn-clear-all").addEventListener("click", async () => {
    if (!confirm("Delete all uploaded files? This cannot be undone.")) return;
    try {
        const res = await fetch("/api/files/all", { method: "DELETE" });
        if (res.ok) {
            showToast("All files cleared", "info");
            fetchFiles();
            fetchStorage();
        } else {
            showToast("Clear failed", "error");
        }
    } catch {
        showToast("Clear failed", "error");
    }
});


/* ═══════════════════════════════════════════════════════════════
   STORAGE
   ═══════════════════════════════════════════════════════════════ */
async function fetchStorage() {
    try {
        const res = await fetch("/api/storage");
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById("storage-used").textContent = formatBytes(data.used_bytes);
    } catch { /* ignore */ }
}


/* ═══════════════════════════════════════════════════════════════
   QR CODE PANEL
   ═══════════════════════════════════════════════════════════════ */
const qrPanel = document.getElementById("qr-panel");
const qrBackdrop = document.getElementById("qr-backdrop");
const btnToggleQr = document.getElementById("btn-toggle-qr");
const qrClose = document.getElementById("qr-close");

function openQrPanel() {
    qrPanel.classList.add("active");
    qrBackdrop.classList.add("active");
    fetchQr();
}
function closeQrPanel() {
    qrPanel.classList.remove("active");
    qrBackdrop.classList.remove("active");
}

btnToggleQr.addEventListener("click", openQrPanel);
qrClose.addEventListener("click", closeQrPanel);
qrBackdrop.addEventListener("click", closeQrPanel);

async function fetchQr() {
    try {
        const res = await fetch("/api/qr");
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById("qr-image").src = data.qr;
        document.getElementById("qr-url").textContent = data.url;
    } catch { /* ignore */ }
}

async function fetchNetworkInfo() {
    try {
        const res = await fetch("/api/network-info");
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById("network-url").textContent = `${data.ip}:${data.port}`;
        if (data.pin) {
            document.getElementById("qr-pin").textContent = `PIN: ${data.pin}`;
        }
    } catch { /* ignore */ }
}


/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(isoString) {
    try {
        const d = new Date(isoString);
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);

        if (diffMin < 1) return "Just now";
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return d.toLocaleDateString();
    } catch {
        return "";
    }
}

function getFileIcon(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    const icons = {
        pdf: "📄", doc: "📝", docx: "📝", txt: "📝",
        png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️",
        mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬",
        mp3: "🎵", wav: "🎵", flac: "🎵", aac: "🎵",
        zip: "📦", rar: "📦", "7z": "📦", tar: "📦", gz: "📦",
        py: "🐍", js: "💛", html: "🌐", css: "🎨", json: "📋",
    };
    return icons[ext] || "📁";
}


/* ═══════════════════════════════════════════════════════════════
   APP INITIALISATION
   ═══════════════════════════════════════════════════════════════ */
function initApp() {
    // Start WebSocket connection
    wsManager = new WSManager();
    wsManager.connect();

    // Fetch initial state
    fetchNetworkInfo();
    fetchClipboard();
    fetchFiles();
    fetchStorage();
}

// Entry point
checkAuth();
