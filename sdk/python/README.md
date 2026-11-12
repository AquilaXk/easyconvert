# EasyConvert Python SDK

Python 3.11 or newer.

- `easyconvert/_generated` is written by `npm run sdk:generate` (openapi-python-client, from `GET /api/v1/openapi.json`). It holds one
  module per operation under `api/default` and the attrs models under `models`. `npm run sdk:check` fails when it is out of date.
- `easyconvert/client.py` is hand-written: upload a file, poll a job, download the result. `EasyConvertClient.generated` is the
  authenticated generated client, for every other operation.

```python
from easyconvert import EasyConvertClient

client = EasyConvertClient(api_key="ec_live_...")
job = client.create_job(open("report.docx", "rb"), "pdf", filename="report.docx")
done = client.wait_for_job(job.job_id)
pdf = client.download(done.result.download_url)
```
