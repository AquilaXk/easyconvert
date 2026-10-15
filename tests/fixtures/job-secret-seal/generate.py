#!/usr/bin/env python3
"""Generates known-answer.json for tests/job-secret-seal-known-answer.test.ts.

The blob is produced with Python `cryptography` (HKDF-SHA256 and AES-256-GCM), never with the
code under test, from the fixed inputs below. Re-running this script must reproduce the committed
file byte for byte; if it does not, the wire format changed and the change is deliberate or a bug.

  python3 tests/fixtures/job-secret-seal/generate.py > tests/fixtures/job-secret-seal/known-answer.json

Wire format: sealed:v1:<kid>:<nonce>:<tag>:<ciphertext>, parts base64 except the key id (hex).
  key  = HKDF-SHA256(ikm=KEK utf-8, salt="easyconvert-job-seal-salt", info="easyconvert-job-secret-seal-v1", 32 bytes)
  kid  = first 12 hex characters of SHA-256("easyconvert-job-secret-kid-v1" || key)
  AEAD = AES-256-GCM, 96-bit nonce, 128-bit tag, AAD = job id (utf-8)
"""
import base64
import hashlib
import json

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEK = "known-answer-kek-0123456789abcdef-xyz"
JOB_ID = "g_kat123:import_source"
NONCE = bytes(range(12))
PLAINTEXT = '{"url":"https://files.example.org/in/data.csv?X-Amz-Signature=abc123","headers":{"X-Api-Key":"k-1"}}'


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


key = HKDF(
    algorithm=hashes.SHA256(),
    length=32,
    salt=b"easyconvert-job-seal-salt",
    info=b"easyconvert-job-secret-seal-v1",
).derive(KEK.encode("utf-8"))
kid = hashlib.sha256(b"easyconvert-job-secret-kid-v1" + key).hexdigest()[:12]
sealed = AESGCM(key).encrypt(NONCE, PLAINTEXT.encode("utf-8"), JOB_ID.encode("utf-8"))
ciphertext, tag = sealed[:-16], sealed[-16:]
blob = f"sealed:v1:{kid}:{b64(NONCE)}:{b64(tag)}:{b64(ciphertext)}"

print(
    json.dumps(
        {
            "generatedWith": "python3 + cryptography (HKDF-SHA256, AESGCM); see generate.py",
            "kek": KEK,
            "jobId": JOB_ID,
            "plaintext": PLAINTEXT,
            "keyId": kid,
            "blob": blob,
        },
        indent=2,
    )
)
