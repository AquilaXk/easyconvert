"""Hand-written convenience layer over the generated client in ``easyconvert._generated``: upload, poll a job, download the
result. ``EasyConvertClient.generated`` is the authenticated generated client, for every other operation."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from io import BytesIO
from typing import Any, BinaryIO

import httpx2

from ._generated.api.default import convert_file_v1, create_job_v1, get_job_status_v1
from ._generated.client import AuthenticatedClient
from ._generated.models.conversion_response import ConversionResponse
from ._generated.models.convert_file_v1_body import ConvertFileV1Body
from ._generated.models.convert_file_v1_response_202 import ConvertFileV1Response202
from ._generated.models.create_job_v1_files_body import CreateJobV1FilesBody
from ._generated.models.create_job_v1_response_202 import CreateJobV1Response202
from ._generated.models.job_details import JobDetails
from ._generated.models.problem_details import ProblemDetails
from ._generated.types import UNSET, File, Response

DEFAULT_BASE_URL = "https://easyconvert.app"
DEFAULT_TIMEOUT_SECONDS = 30.0
TERMINAL_JOB_STATUSES = frozenset({"completed", "failed", "cancelled"})
HTTP_ERROR_FLOOR = 400


class EasyConvertApiError(Exception):
    """The API answered with an error status; ``problem`` is its problem document when it sent one."""

    def __init__(self, status_code: int, problem: ProblemDetails | None):
        detail = (problem.detail if problem is not None and problem.detail is not UNSET else None) or "request failed"
        super().__init__(f"EasyConvert API error ({status_code}): {detail}")
        self.status_code = status_code
        self.problem = problem


def _as_file(file: bytes | BinaryIO, filename: str) -> File:
    return File(payload=BytesIO(file) if isinstance(file, bytes) else file, file_name=filename)


def _problem(response: Response[Any]) -> ProblemDetails | None:
    try:
        return ProblemDetails.from_dict(json.loads(response.content))
    except (ValueError, AttributeError, KeyError, TypeError):
        return None


def _checked(response: Response[Any]) -> Any:
    if response.status_code >= HTTP_ERROR_FLOOR or response.parsed is None:
        raise EasyConvertApiError(int(response.status_code), _problem(response))
    return response.parsed


def _origin(url: httpx2.URL) -> tuple[str, str, int | None]:
    return (url.scheme, url.host, url.port)


class EasyConvertClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = DEFAULT_TIMEOUT_SECONDS):
        if not api_key or not api_key.strip():
            raise ValueError("EasyConvertClient needs an API key")
        self.generated = AuthenticatedClient(
            base_url=base_url.rstrip("/"),
            token=api_key.strip(),
            timeout=httpx2.Timeout(timeout),
        )

    def convert(
        self,
        file: bytes | BinaryIO,
        target_format: str,
        filename: str = "input.bin",
        source_format: str | None = None,
        options: Mapping[str, Any] | None = None,
        respond_async: bool = False,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
    ) -> ConversionResponse | ConvertFileV1Response202:
        """Converts a file. The answer is the result, or the queued job when the file is over the synchronous limit or
        ``respond_async`` is set."""
        body = ConvertFileV1Body(
            file=_as_file(file, filename),
            target_format=target_format,
            source_format=source_format or UNSET,
            options=json.dumps(options) if options else UNSET,
            webhook_url=webhook_url or UNSET,
            webhook_secret=webhook_secret or UNSET,
        )
        response = convert_file_v1.sync_detailed(
            client=self.generated, body=body, prefer="respond-async" if respond_async else UNSET
        )
        return _checked(response)

    def create_job(
        self,
        file: bytes | BinaryIO,
        target_format: str,
        filename: str = "input.bin",
        source_format: str | None = None,
        options: Mapping[str, Any] | None = None,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
    ) -> CreateJobV1Response202:
        """Queues a conversion job for a file; follow it with ``wait_for_job``."""
        body = CreateJobV1FilesBody(
            file=_as_file(file, filename),
            target_format=target_format,
            source_format=source_format or UNSET,
            options=json.dumps(options) if options else UNSET,
            webhook_url=webhook_url or UNSET,
            webhook_secret=webhook_secret or UNSET,
        )
        return _checked(create_job_v1.sync_detailed(client=self.generated, body=body))

    def get_job(self, job_id: str) -> JobDetails:
        return _checked(get_job_status_v1.sync_detailed(job_id, client=self.generated))

    def wait_for_job(self, job_id: str, interval: float = 1.0, timeout: float = 300.0) -> JobDetails:
        """Polls until the job completed, failed or was cancelled and returns its last state; check ``status``."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if job.status is not UNSET and job.status.value in TERMINAL_JOB_STATUSES:
                return job
            if time.monotonic() + interval > deadline:
                raise TimeoutError(f"Job {job_id} did not finish within {timeout} s")
            time.sleep(interval)

    def download(self, download_url: str) -> bytes:
        """Downloads the bytes of a finished conversion from the ``download_url`` of its result. The API key goes only to
        the origin of the base URL: a link to another origin is fetched without it."""
        client = self.generated.get_httpx_client()
        url = client.base_url.join(download_url)
        if _origin(url) == _origin(client.base_url):
            response = client.get(url)
        else:
            response = httpx2.get(url, timeout=client.timeout)
        if response.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(response.status_code, None)
        return response.content

    def create_graph_job(
        self,
        graph: Mapping[str, Any] | str,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
    ) -> dict[str, Any]:
        """Queues a graph processing job and returns its id and status url."""
        client = self.generated.get_httpx_client()
        graph_obj = json.loads(graph) if isinstance(graph, str) else graph
        payload: dict[str, Any] = {"graph": graph_obj}
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        response = client.post("/api/v1/jobs", json=payload)
        if response.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(response.status_code, _problem(response))
        return response.json()

    def upload_tus(
        self,
        file: bytes | BinaryIO,
        filename: str = "upload.bin",
        mime_type: str | None = None,
        chunk_size: int = 5 * 1024 * 1024,
    ) -> dict[str, Any]:
        """Resumable upload via TUS 1.0 protocol in chunks."""
        import base64

        client = self.generated.get_httpx_client()
        content = file.read() if hasattr(file, "read") else file
        total_size = len(content)

        metadata_parts = [f"filename {base64.b64encode(filename.encode('utf-8')).decode('ascii')}"]
        if mime_type:
            metadata_parts.append(f"filetype {base64.b64encode(mime_type.encode('utf-8')).decode('ascii')}")

        init_res = client.post(
            "/api/v1/uploads",
            headers={
                "Tus-Resumable": "1.0.0",
                "Upload-Length": str(total_size),
                "Upload-Metadata": ",".join(metadata_parts),
            },
        )
        if init_res.status_code != 201:
            raise EasyConvertApiError(init_res.status_code, _problem(init_res))

        location = init_res.headers.get("Location", "")
        upload_id = location.rstrip("/").split("/")[-1]
        storage_key = init_res.headers.get("Storage-Key")

        offset = 0
        while offset < total_size:
            end = min(offset + chunk_size, total_size)
            chunk = content[offset:end]
            patch_res = client.patch(
                location,
                headers={
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": str(offset),
                    "Content-Type": "application/offset+octet-stream",
                },
                content=chunk,
            )
            if patch_res.status_code != 204:
                raise EasyConvertApiError(patch_res.status_code, _problem(patch_res))
            new_offset = patch_res.headers.get("Upload-Offset")
            offset = int(new_offset) if new_offset else end
            if "Storage-Key" in patch_res.headers:
                storage_key = patch_res.headers.get("Storage-Key")

        return {"uploadId": upload_id, "storageKey": storage_key, "location": location}

    def upload_multipart(
        self,
        file: bytes | BinaryIO,
        filename: str = "upload.bin",
        part_size: int | None = None,
    ) -> dict[str, Any]:
        """Direct multipart upload via presigned / direct upload URLs."""
        client = self.generated.get_httpx_client()
        content = file.read() if hasattr(file, "read") else file
        total_size = len(content)

        init_payload: dict[str, Any] = {"filename": filename, "totalSize": total_size}
        if part_size:
            init_payload["partSize"] = part_size

        init_res = client.post("/api/v1/uploads/direct", json=init_payload)
        if init_res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(init_res.status_code, _problem(init_res))

        init_data = init_res.json()
        upload_id = init_data["uploadId"]
        part_size_actual = init_data.get("partSize", 5 * 1024 * 1024)
        part_urls = init_data.get("partUrls", [])

        parts = []
        for part_info in part_urls:
            p_num = part_info["partNumber"]
            start = (p_num - 1) * part_size_actual
            end = min(start + part_size_actual, total_size)
            chunk = content[start:end]
            put_res = httpx2.put(part_info["url"], content=chunk, timeout=client.timeout)
            if put_res.status_code >= HTTP_ERROR_FLOOR:
                raise EasyConvertApiError(put_res.status_code, None)
            etag = put_res.headers.get("ETag", f'"{p_num}"')
            parts.append({"partNumber": p_num, "etag": etag})

        comp_res = client.post(
            "/api/v1/uploads/direct/complete",
            json={"uploadId": upload_id, "parts": parts},
        )
        if comp_res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(comp_res.status_code, _problem(comp_res))

        comp_data = comp_res.json()
        return {"storageKey": comp_data.get("storageKey", init_data.get("storageKey")), "uploadId": upload_id}

    def inspect_archive(
        self,
        file: bytes | BinaryIO | None = None,
        storage_key: str | None = None,
        filename: str = "archive.zip",
        password: str | None = None,
    ) -> dict[str, Any]:
        """Inspects archive structure and encryption without unpacking."""
        client = self.generated.get_httpx_client()
        if file is not None:
            files_dict: dict[str, Any] = {"file": _as_file(file, filename)}
            data_dict: dict[str, Any] = {}
            if password:
                data_dict["password"] = password
            res = client.post("/api/v1/archive/inspect", files=files_dict, data=data_dict)
        elif storage_key:
            payload: dict[str, Any] = {"storageKey": storage_key, "filename": filename}
            if password:
                payload["password"] = password
            res = client.post("/api/v1/archive/inspect", json=payload)
        else:
            raise ValueError("inspect_archive requires either file or storage_key")

        if res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(res.status_code, _problem(res))
        return res.json()

    def create_credential(
        self,
        provider_type: str,
        credentials: Mapping[str, Any],
        name: str | None = None,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Registers encrypted storage credentials."""
        client = self.generated.get_httpx_client()
        payload: dict[str, Any] = {"providerType": provider_type, "credentials": dict(credentials)}
        if name:
            payload["name"] = name
        if ttl_seconds:
            payload["ttlSeconds"] = ttl_seconds
        res = client.post("/api/v1/storage/credentials", json=payload)
        if res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(res.status_code, _problem(res))
        return res.json()

    def list_credentials(self) -> dict[str, Any]:
        """Lists registered storage credentials (references only)."""
        client = self.generated.get_httpx_client()
        res = client.get("/api/v1/storage/credentials")
        if res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(res.status_code, _problem(res))
        return res.json()

    def delete_credential(self, credential_id: str) -> None:
        """Deletes registered storage credentials by reference."""
        client = self.generated.get_httpx_client()
        res = client.delete(f"/api/v1/storage/credentials/{credential_id}")
        if res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(res.status_code, _problem(res))

    @staticmethod
    def verify_webhook_signature(
        payload: str,
        signature: str,
        timestamp: int,
        secret: str,
        tolerance_seconds: int = 300,
    ) -> bool:
        """Verifies incoming HMAC-SHA256 webhook signature."""
        import hashlib
        import hmac

        if abs(int(time.time()) - timestamp) > tolerance_seconds:
            return False
        expected = hmac.new(secret.encode("utf-8"), f"{timestamp}.{payload}".encode("utf-8"), hashlib.sha256).hexdigest()
        clean_sig = signature.removeprefix("sha256=").strip()
        return hmac.compare_digest(clean_sig, expected)
