import { useTranslations } from 'next-intl';
import { SYNC_CONVERSION_MAX_BYTES } from '@/lib/api/file-size-limit';
import { formatBytes } from '@/lib/format-bytes';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '@/lib/plan-limits';
import CodeBlock from './CodeBlock';
import { DOC, richText } from './doc-text';
import { convertSample, createJobSample, downloadSample, showJobSample, startUploadSample } from './guide-samples';

export default function QuickstartGuide({ origin }: Readonly<{ origin: string }>) {
  const t = useTranslations('apiDocs');
  const heading = (id: string) => t(`quickstart.headings.${id}` as 'quickstart.headings.create-a-key');
  const copy = { copyLabel: t('operation.copy'), copiedLabel: t('operation.copied') };
  const values = { ...richText, syncMax: formatBytes(SYNC_CONVERSION_MAX_BYTES), requestMax: formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES) };
  const p = (key: Parameters<typeof t.rich>[0]) => <p className={DOC.p}>{t.rich(key, values)}</p>;
  const step = (key: Parameters<typeof t.rich>[0]) => <li className={DOC.listItem}>{t.rich(key, values)}</li>;

  return (
    <>
      {p('quickstart.lead')}

      <h2 id="create-a-key" className={DOC.h2}>{heading('create-a-key')}</h2>
      {p('quickstart.createKey1')}
      {p('quickstart.createKey2')}

      <h2 id="convert-a-file" className={DOC.h2}>{heading('convert-a-file')}</h2>
      {p('quickstart.convert1')}
      <CodeBlock code={convertSample(origin)} {...copy} />
      {p('quickstart.convert2')}
      {p('quickstart.convert3')}

      <h2 id="convert-a-large-file" className={DOC.h2}>{heading('convert-a-large-file')}</h2>
      {p('quickstart.large1')}
      <ol className="list-decimal ps-6 my-5 marker:text-ink-3">
        {step('quickstart.largeStep1')}
        {step('quickstart.largeStep2')}
        {step('quickstart.largeStep3')}
      </ol>
      <CodeBlock code={startUploadSample(origin)} {...copy} />
      {p('quickstart.large2')}
      <CodeBlock code={createJobSample(origin)} {...copy} />
      {p('quickstart.large3')}
      <CodeBlock code={showJobSample(origin)} {...copy} />

      <h2 id="download-the-result" className={DOC.h2}>{heading('download-the-result')}</h2>
      {p('quickstart.download1')}
      <CodeBlock code={downloadSample(origin)} {...copy} />
      {p('quickstart.download2')}
    </>
  );
}
