'use client';

import React, { useRef, useState } from 'react';
import { Check, Code2, Copy } from 'lucide-react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';

type SnippetLanguage = 'curl' | 'node' | 'python';

const SNIPPET_TABS: ReadonlyArray<SnippetLanguage> = ['curl', 'node', 'python'];

const TAB_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  node: 'Node.js',
  python: 'Python',
};

interface IntegrationGuideProps {
  sampleKeyDisplay: string;
}

export function IntegrationGuide({ sampleKeyDisplay }: Readonly<IntegrationGuideProps>) {
  const [codeTab, setCodeTab] = useState<SnippetLanguage>('curl');
  const { copiedKey, copyText } = useCopyFeedback(2000);
  const copiedSnippet = copiedKey === 'snippet';
  const tabRefs = useRef<Record<SnippetLanguage, HTMLButtonElement | null>>({
    curl: null,
    node: null,
    python: null,
  });

  const codeSnippets: Record<SnippetLanguage, string> = {
    curl: String.raw`curl -X POST "https://api.easyconvert.com/api/v1/convert" \
  -H "Authorization: Bearer ${sampleKeyDisplay}" \
  -F "file=@document.docx" \
  -F "targetFormat=pdf"`,
    node: `import fs from 'node:fs';

const formData = new FormData();
formData.append('file', new Blob([fs.readFileSync('document.docx')]), 'document.docx');
formData.append('targetFormat', 'pdf');

const res = await fetch('https://api.easyconvert.com/api/v1/convert', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ${sampleKeyDisplay}',
  },
  body: formData,
});

const result = await res.json();
console.log(result);`,
    python: `import requests

url = "https://api.easyconvert.com/api/v1/convert"
headers = {"Authorization": "Bearer ${sampleKeyDisplay}"}
with open("document.docx", "rb") as source_file:
    response = requests.post(
        url,
        headers=headers,
        files={"file": source_file},
        data={"targetFormat": "pdf"},
        timeout=60,
    )
print(response.json())`,
  };

  const handleCopySnippet = () => {
    void copyText(codeSnippets[codeTab], 'snippet');
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: SnippetLanguage
  ) => {
    const currentIndex = SNIPPET_TABS.indexOf(currentTab);
    if (currentIndex === -1) return;

    let nextTab: SnippetLanguage | null = null;
    if (event.key === 'ArrowRight') {
      nextTab = SNIPPET_TABS[(currentIndex + 1) % SNIPPET_TABS.length];
    } else if (event.key === 'ArrowLeft') {
      nextTab = SNIPPET_TABS[(currentIndex - 1 + SNIPPET_TABS.length) % SNIPPET_TABS.length];
    } else if (event.key === 'Home') {
      nextTab = SNIPPET_TABS[0];
    } else if (event.key === 'End') {
      nextTab = SNIPPET_TABS.at(-1) ?? null;
    }

    if (nextTab) {
      event.preventDefault();
      setCodeTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  const activeTabId = `sdk-guide-tab-${codeTab}`;

  return (
    <div className="border-t border-rule-strong pt-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="text-accent-ink shrink-0">
            <Code2 className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg text-ink">
              Programmatic Integration Guide
            </h2>
            <p className="text-xs text-ink-2 mt-0.5">
              Submit multipart conversion requests with your scoped API key.
            </p>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="SDK language"
          className="flex rounded-md bg-sunken p-1 border border-rule self-start sm:self-auto"
        >
          {SNIPPET_TABS.map((tab) => {
            const isSelected = codeTab === tab;
            return (
              <button
                key={tab}
                id={`sdk-guide-tab-${tab}`}
                ref={(el) => {
                  tabRefs.current[tab] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls="sdk-guide-tabpanel"
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setCodeTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, tab)}
                className={`min-h-[44px] px-3 py-1.5 text-xs font-semibold rounded-sm transition-colors ${
                  isSelected
                    ? 'bg-surface text-accent-ink'
                    : 'text-ink-2 hover:text-ink'
                }`}
              >
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id="sdk-guide-tabpanel"
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="relative mt-4 min-w-0"
      >
        <pre className="p-4 pr-24 rounded-md bg-sunken text-ink-2 font-mono text-xs overflow-x-auto max-w-full leading-relaxed border border-rule">
          <code>{codeSnippets[codeTab]}</code>
        </pre>
        <button
          type="button"
          onClick={handleCopySnippet}
          aria-label={`Copy ${TAB_LABELS[codeTab]} integration snippet`}
          className="min-w-[44px] min-h-[44px] absolute top-2 right-2 inline-flex items-center justify-center gap-1.5 px-2.5 rounded-sm bg-surface hover:bg-canvas border border-rule text-ink-2 hover:text-ink text-xs font-semibold transition-colors"
        >
          {copiedSnippet ? (
            <>
              <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Copy</span>
            </>
          )}
        </button>
        <output aria-live="polite" className="sr-only">
          {copiedSnippet ? `Copied ${TAB_LABELS[codeTab]} integration snippet` : ''}
        </output>
      </div>
    </div>
  );
}
