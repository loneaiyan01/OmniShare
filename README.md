# OmniShare

A production-grade, offline-first local network utility for real-time clipboard synchronization and file sharing across Windows PCs, iPhones, and iPads. 

OmniShare runs entirely on your local network. It generates its own self-signed TLS certificates on the fly, enforces a dynamic 4-digit PIN for security, and requires zero external dependencies (no internet uplink required).

## Features

- **⚡ Real-Time Clipboard Sync:** Instantly copy text on your PC and paste it on your phone (and vice versa) via WebSockets.
- **📁 Drag-and-Drop File Sharing:** Transfer files up to 500MB between devices. 
- **🧹 Auto-Cleanup:** Uploaded files are automatically purged after 24 hours to protect your PC's storage.
- **🔒 Secure Local Network:** Binds to your dynamic local IP and protects access with an auto-generated, in-memory 4-digit PIN.
- **📱 iOS Resilient:** Engineered with Page Visibility APIs and exponential backoff to handle iOS Safari's aggressive background tab freezing.
- **📴 100% Offline Capable:** The backend handles QR code generation directly. It functions flawlessly on air-gapped routers.

## Prerequisites

- Python 3.9+
- A Windows PC (Host)
- Devices connected to the **same Wi-Fi network**.

## Installation & Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/loneaiyan01/OmniShare.git
   cd OmniShare
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Start the server:**
   Double-click `run.bat` or run:
   ```bash
   python main.py
   ```

4. **Connect the Host PC:**
   Open your browser and navigate to `https://localhost:8000`. Accept the self-signed certificate warning and enter the PIN displayed in your terminal.
5. **Connect Mobile Devices:**
   Scan the QR code displayed on the PC's web UI using your phone's camera.

### ⚠️ Important Note for iOS / Safari Users

Because OmniShare operates entirely offline, it generates a **self-signed TLS certificate** to allow secure WebSocket connections (WSS) and modern Clipboard APIs. Safari will show a "Not Secure" warning on the first visit.

To bypass this safely:

1. Tap **Show Details** at the bottom of the warning.
2. Tap **visit this website**.
3. Confirm with your device passcode.

## How It Works

* **Dynamic IP Tracking:** On startup, OmniShare detects your PC's local IPv4 address (e.g., `192.168.1.x`). If your router assigns a new IP (DHCP lease renewal), OmniShare automatically detects this on the next boot and regenerates the TLS certificates to prevent browser mismatch errors.
* **Thread Lifecycle:** Background tasks (clipboard monitoring, auto-cleanup) run as daemon threads with interruptible events, ensuring the server shuts down cleanly without hanging your terminal.
* **Clipboard Fallbacks:** If a browser restricts `navigator.clipboard`, the frontend gracefully falls back to a hidden `<textarea>` execution, ensuring copy/paste works on all devices.

## License

Distributed under the MIT License. See `LICENSE` for more information.
