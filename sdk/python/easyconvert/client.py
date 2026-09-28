import json
import requests
from typing import Optional, Dict, Any, Union, List, BinaryIO
from .models import ConversionResponse, JobSummary, ApiKey, WebhookDlqEntry

class EasyConvertClient:
    """Official EasyConvert REST API client."""

    def __init__(self, api_key: str, base_url: str = "https://easyconvert.app", timeout: float = 30.0):
        if not api_key or not isinstance(api_key, str):
            raise ValueError("api_key must be a valid string starting with ec_live_")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "EasyConvert-Python-SDK/1.0.0",
        })

    def _request(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs.setdefault("timeout", self.timeout)
        resp = self.session.request(method, url, **kwargs)
        if not resp.ok:
            try:
                err_data = resp.json()
                msg = err_data.get("error") or err_data.get("detail") or f"HTTP {resp.status_code}"
            except Exception:
                msg = resp.text or f"HTTP {resp.status_code}"
            raise RuntimeError(f"EasyConvert API Error ({resp.status_code}): {msg}")
        return resp.json()

    def convert(
        self,
        file: Union[bytes, BinaryIO],
        target_format: str,
        filename: str = "input.bin",
        source_format: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        raw: bool = False,
    ) -> Union[Dict[str, Any], bytes]:
        """Convert a file synchronously."""
        url = f"{self.base_url}/api/v1/convert{'?raw=true' if raw else ''}"
        files = {"file": (filename, file)}
        data: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            data["sourceFormat"] = source_format
        if options:
            data["options"] = json.dumps(options)

        headers = {}
        if raw:
            headers["Accept"] = "application/octet-stream"

        resp = self.session.post(url, files=files, data=data, headers=headers, timeout=self.timeout)
        if not resp.ok:
            raise RuntimeError(f"Conversion failed ({resp.status_code}): {resp.text}")
        if raw:
            return resp.content
        return resp.json()

    def _create_job_multipart(
        self,
        target_format: str,
        file: Union[bytes, BinaryIO],
        filename: Optional[str],
        source_format: Optional[str],
        options: Optional[Dict[str, Any]],
        webhook_url: Optional[str],
        webhook_secret: Optional[str],
    ) -> Dict[str, Any]:
        files = {"file": (filename or "upload.bin", file)}
        data: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            data["sourceFormat"] = source_format
        if options:
            data["options"] = json.dumps(options)
        if webhook_url:
            data["webhookUrl"] = webhook_url
        if webhook_secret:
            data["webhookSecret"] = webhook_secret
        url = f"{self.base_url}/api/v1/jobs"
        resp = self.session.post(url, files=files, data=data, timeout=self.timeout)
        if not resp.ok:
            raise RuntimeError(f"Job creation failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def create_job(
        self,
        target_format: str,
        file: Optional[Union[bytes, BinaryIO]] = None,
        filename: Optional[str] = None,
        source_format: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit an asynchronous conversion job."""
        if file is not None:
            return self._create_job_multipart(
                target_format, file, filename, source_format, options, webhook_url, webhook_secret
            )

        payload: Dict[str, Any] = {"targetFormat": target_format}
        if source_format:
            payload["sourceFormat"] = source_format
        if options:
            payload["options"] = options
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        return self._request("POST", "/api/v1/jobs", json=payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """Get job status and result."""
        return self._request("GET", f"/api/v1/jobs/{job_id}")

    def list_jobs(self, status: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
        """List conversion jobs."""
        params = {"limit": limit}
        if status:
            params["status"] = status
        return self._request("GET", "/api/v1/jobs", params=params)

    def list_api_keys(self) -> List[Dict[str, Any]]:
        """List API keys."""
        res = self._request("GET", "/api/keys")
        return res.get("keys", [])

    def create_api_key(
        self,
        name: str,
        scopes: Optional[List[str]] = None,
        expires_at: Optional[int] = None,
        allowed_ips: Optional[List[str]] = None,
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new API key."""
        payload: Dict[str, Any] = {"name": name}
        if scopes:
            payload["scopes"] = scopes
        if expires_at:
            payload["expiresAt"] = expires_at
        if allowed_ips:
            payload["allowedIps"] = allowed_ips
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        return self._request("POST", "/api/keys", json=payload)

    def revoke_api_key(self, key_id: str) -> bool:
        """Revoke an API key."""
        res = self._request("DELETE", f"/api/keys/{key_id}")
        return res.get("success", False)

    def get_dlq_entries(self) -> List[Dict[str, Any]]:
        """List dead-lettered webhook entries."""
        res = self._request("GET", "/api/webhooks/dlq")
        return res.get("entries", [])

    def replay_dlq(self, dlq_id: str) -> Dict[str, Any]:
        """Replay a dead-lettered webhook."""
        return self._request("POST", f"/api/webhooks/dlq/{dlq_id}/replay")
