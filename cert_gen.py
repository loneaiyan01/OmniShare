"""
cert_gen.py — Self-signed TLS certificate generator for OmniShare.

Generates an RSA 2048-bit key and X.509 certificate with SAN entries
for localhost, 127.0.0.1, and the PC's detected local network IP.
Tracks the generation IP in certs/meta.json and regenerates automatically
if the IP changes (e.g. DHCP lease renewal).
"""

import json
import socket
import datetime
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def get_local_ip() -> str:
    """Detect the PC's primary local IPv4 address via a dummy UDP socket.
    No actual traffic is transmitted."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_certs(certs_dir: str, local_ip: str) -> tuple:
    """
    Verify or create TLS certificate files.

    Returns:
        (cert_file_path, key_file_path) as strings.
    """
    certs_path = Path(certs_dir)
    certs_path.mkdir(parents=True, exist_ok=True)

    cert_file = certs_path / "cert.pem"
    key_file = certs_path / "key.pem"
    meta_file = certs_path / "meta.json"

    # ------------------------------------------------------------------
    # Check whether the existing certificate matches the current IP
    # ------------------------------------------------------------------
    needs_regen = True
    if cert_file.exists() and key_file.exists() and meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text())
            if meta.get("ip") == local_ip:
                needs_regen = False
        except (json.JSONDecodeError, KeyError, OSError):
            pass

    if not needs_regen:
        print(f"  [CERT] Existing certificate valid for IP: {local_ip}")
        return str(cert_file), str(key_file)

    # ------------------------------------------------------------------
    # Wipe stale files and regenerate
    # ------------------------------------------------------------------
    for f in (cert_file, key_file, meta_file):
        if f.exists():
            f.unlink()

    # Generate a 2048-bit RSA private key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Build the X.509 subject / issuer
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "OmniShare"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "OmniShare Local"),
        ]
    )

    # Subject Alternative Names — critical for browser acceptance
    san_entries = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address(local_ip)),
    ]

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(key, hashes.SHA256())
    )

    # Persist key
    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )

    # Persist certificate
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))

    # Persist generation metadata
    meta_file.write_text(
        json.dumps({"ip": local_ip, "generated_at": now.isoformat()})
    )

    print(f"  [CERT] Generated new TLS certificate for IP: {local_ip}")
    return str(cert_file), str(key_file)
