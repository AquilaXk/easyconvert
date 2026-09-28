from typing import Optional, List, Dict, Any, Union
from dataclasses import dataclass

@dataclass
class ConversionResponse:
    success: bool
    file_id: str
    file_name: str
    source_format: str
    target_format: str
    mime_type: str
    size: int
    duration_ms: float
    data_uri: str
    download_url: str
    expires_at: int

@dataclass
class JobSummary:
    job_id: str
    status: str
    created_at: int
    source_format: Optional[str] = None
    target_format: Optional[str] = None
    original_filename: Optional[str] = None
    file_size: Optional[int] = None
    progress: Optional[float] = None
    processed_on: Optional[int] = None
    finished_on: Optional[int] = None
    failed_reason: Optional[str] = None

@dataclass
class ApiKey:
    id: str
    user_id: str
    name: str
    prefix: str
    created_at: int
    status: str
    last_used_at: Optional[int] = None
    expires_at: Optional[int] = None
    allowed_ips: Optional[List[str]] = None
    webhook_url: Optional[str] = None
    scopes: Optional[List[str]] = None

@dataclass
class WebhookDlqEntry:
    id: str
    original_delivery_id: str
    target_url: str
    event: str
    payload: Dict[str, Any]
    failed_at: int
    retry_count: int
    status: str
    final_status_code: Optional[int] = None
    error_message: Optional[str] = None
    replayed_at: Optional[int] = None
