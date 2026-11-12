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
        """Downloads the bytes of a finished conversion from the ``download_url`` of its result."""
        response = self.generated.get_httpx_client().get(download_url)
        if response.status_code >= HTTP_ERROR_FLOOR:
            raise EasyConvertApiError(response.status_code, None)
        return response.content
