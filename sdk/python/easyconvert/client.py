"""Hand-written convenience layer over the generated client in ``easyconvert._generated``: upload, poll a job, download the
result. ``EasyConvertClient.generated`` is the authenticated generated client, for every other operation."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Iterator, Mapping
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

DEFAULT_BASE_URL = "https://convert.aquilaxk.site"
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


def _extract_tus_storage_key(headers: Mapping[str, str]) -> str | None:
    return headers.get("EasyConvert-Storage-Key") or headers.get("X-Storage-Key") or headers.get("Storage-Key")


def _stream_bounds(file: bytes | bytearray | memoryview | BinaryIO) -> tuple[int, int]:
    """Returns `(start_offset, total_size)` without reading the entire stream into memory."""
    if isinstance(file, (bytes, bytearray, memoryview)):
        return (0, len(file))
    if not hasattr(file, "seek") or not hasattr(file, "tell"):
        raise ValueError("Binary stream must be seekable to determine byte length without full buffering.")
    start_pos = file.tell()
    file.seek(0, 2)
    end_pos = file.tell()
    file.seek(start_pos, 0)
    return (start_pos, max(0, end_pos - start_pos))


def _read_exact_slice(
    file: bytes | bytearray | memoryview | BinaryIO,
    start_pos: int,
    offset: int,
    size: int,
) -> bytes:
    """Reads `[offset, offset + size)` bytes cleanly in chunks from bytes or BinaryIO."""
    if size <= 0:
        return b""
    if isinstance(file, (bytes, bytearray, memoryview)):
        return bytes(memoryview(file)[offset : offset + size])
    file.seek(start_pos + offset, 0)
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        piece = file.read(remaining)
        if not piece:
            break
        chunks.append(piece)
        remaining -= len(piece)
    return b"".join(chunks)


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
        idempotency_key: str | None = None,
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
            client=self.generated,
            body=body,
            prefer="respond-async" if respond_async else UNSET,
            idempotency_key=idempotency_key or UNSET,
        )
        return _checked(response)

    def create_job(
        self,
        file: bytes | BinaryIO | None = None,
        target_format: str = "",
        filename: str = "input.bin",
        source_format: str | None = None,
        options: Mapping[str, Any] | None = None,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
        source_url: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateJobV1Response202:
        """Queues a conversion job for a file; follow it with ``wait_for_job``."""
        if file is None and source_url is not None:
            client = self.generated.get_httpx_client()
            payload: dict[str, Any] = {"sourceUrl": source_url, "targetFormat": target_format}
            if source_format:
                payload["sourceFormat"] = source_format
            if options:
                payload["options"] = dict(options)
            if webhook_url:
                payload["webhookUrl"] = webhook_url
            if webhook_secret:
                payload["webhookSecret"] = webhook_secret
            headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
            res = client.post("/api/v1/jobs", json=payload, headers=headers)
            if res.status_code >= HTTP_ERROR_FLOOR:
                raise EasyConvertApiError(res.status_code, _problem(res))
            return CreateJobV1Response202.from_dict(res.json())
        if file is None:
            raise ValueError("create_job requires either file or source_url")
        body = CreateJobV1FilesBody(
            file=_as_file(file, filename),
            target_format=target_format,
            source_format=source_format or UNSET,
            options=json.dumps(options) if options else UNSET,
            webhook_url=webhook_url or UNSET,
            webhook_secret=webhook_secret or UNSET,
        )
        return _checked(
            create_job_v1.sync_detailed(
                client=self.generated,
                body=body,
                idempotency_key=idempotency_key or UNSET,
            )
        )

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

    def download_stream(self, download_url: str, chunk_size: int = 65536) -> Iterator[bytes]:
        """Streams the bytes of a finished conversion from ``download_url`` in bounded chunks."""
        client = self.generated.get_httpx_client()
        url = client.base_url.join(download_url)
        stream_ctx = (
            client.stream("GET", url)
            if _origin(url) == _origin(client.base_url)
            else httpx2.stream("GET", url, timeout=client.timeout)
        )
        with stream_ctx as response:
            if response.status_code >= HTTP_ERROR_FLOOR:
                raise EasyConvertApiError(response.status_code, None)
            yield from response.iter_bytes(chunk_size=chunk_size)

    def create_graph_job(
        self,
        graph: Mapping[str, Any] | str,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Queues a graph processing job and returns its id and status url."""
        client = self.generated.get_httpx_client()
        graph_obj = json.loads(graph) if isinstance(graph, str) else graph
        payload: dict[str, Any] = {"graph": graph_obj}
        if webhook_url:
            payload["webhookUrl"] = webhook_url
        if webhook_secret:
            payload["webhookSecret"] = webhook_secret
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        response = client.post("/api/v1/jobs", json=payload, headers=headers)
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
        """Resumable upload via TUS 1.0 protocol, reading seekable BinaryIO in bounded chunks."""
        client = self.generated.get_httpx_client()
        start_pos, total_size = _stream_bounds(file)

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
        storage_key = _extract_tus_storage_key(init_res.headers)

        offset = 0
        while offset < total_size:
            to_read = min(chunk_size, total_size - offset)
            chunk = _read_exact_slice(file, start_pos, offset, to_read)
            if not chunk:
                break
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
            offset = int(new_offset) if new_offset else (offset + len(chunk))
            patch_key = _extract_tus_storage_key(patch_res.headers)
            if patch_key:
                storage_key = patch_key

        return {"uploadId": upload_id, "storageKey": storage_key, "location": location}

    def upload_multipart(
        self,
        file: bytes | BinaryIO,
        filename: str = "upload.bin",
        mime_type: str | None = None,
        part_size: int | None = None,
    ) -> dict[str, Any]:
        """Direct multipart upload via presigned / direct upload URLs in bounded part slices."""
        client = self.generated.get_httpx_client()
        start_pos, total_size = _stream_bounds(file)

        init_payload: dict[str, Any] = {"filename": filename, "totalSize": total_size}
        if mime_type:
            init_payload["mimeType"] = mime_type
        if part_size:
            init_payload["partSize"] = part_size

        init_res = client.post("/api/v1/uploads/direct", json=init_payload)
        if init_res.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(init_res.status_code, _problem(init_res))

        init_data = init_res.json()
        upload_id = init_data["uploadId"]
        part_size_actual = init_data.get("partSize", 5 * 1024 * 1024)
        part_list = init_data.get("parts") or init_data.get("partUrls") or []

        parts = []
        for part_info in part_list:
            p_num = part_info["partNumber"]
            raw_url = part_info.get("uploadUrl") or part_info.get("url")
            if not raw_url:
                raise ValueError(f"Missing upload URL for multipart part {p_num}")
            target_url = str(client.base_url.join(raw_url))
            start = (p_num - 1) * part_size_actual
            part_len = max(0, min(part_size_actual, total_size - start))
            chunk = _read_exact_slice(file, start_pos, start, part_len)
            put_res = httpx2.put(
                target_url,
                content=chunk,
                headers={"Content-Length": str(len(chunk))},
                timeout=client.timeout,
            )
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
        return {
            "storageKey": comp_data.get("storageKey") or comp_data.get("key") or init_data.get("key") or init_data.get("storageKey"),
            "uploadId": upload_id,
        }

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
            res = client.post("/api/v1/archives/inspect", files=files_dict, data=data_dict)
        elif storage_key:
            payload: dict[str, Any] = {"storageKey": storage_key, "filename": filename}
            if password:
                payload["password"] = password
            res = client.post("/api/v1/archives/inspect", json=payload)
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
        delivery_id: str | None = None,
        *,
        webhook_id: str | None = None,
    ) -> bool:
        """Verifies Standard Webhooks (``v1,<base64>``) and legacy hex HMAC-SHA256 webhook signatures."""
        if abs(int(time.time()) - timestamp) > tolerance_seconds:
            return False

        resolved_id = delivery_id if delivery_id is not None else webhook_id
        trimmed_sig = signature.strip()
        tokens = trimmed_sig.split()
        is_standard = resolved_id is not None or any(tok.startswith("v1,") for tok in tokens)

        if is_standard:
            if not resolved_id:
                return False
            digest = hmac.new(
                secret.encode("utf-8"),
                f"{resolved_id}.{timestamp}.{payload}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
            expected_tok = f"v1,{base64.b64encode(digest).decode('ascii')}"
            matched = False
            for tok in tokens:
                if hmac.compare_digest(tok, expected_tok):
                    matched = True
            return matched

        expected = hmac.new(secret.encode("utf-8"), f"{timestamp}.{payload}".encode("utf-8"), hashlib.sha256).hexdigest()
        clean_sig = trimmed_sig.removeprefix("sha256=").strip()
        return hmac.compare_digest(clean_sig, expected)
