'use client';

import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  Search,
  Copy,
  Check,
  ChevronDown,
  Terminal,
  Code2,
  Cpu,
  BookOpen,
  ExternalLink,
  Layers,
  ArrowRight,
  Sparkles,
  RefreshCw,
  Globe,
  Sliders,
  ShieldCheck,
  Boxes,
  Zap,
} from 'lucide-react';

const SD_KS = [
  { name: 'PHP SDK', icon: '🐘', desc: 'Composer package for PHP 8+' },
  { name: 'Laravel SDK', icon: '🔴', desc: 'Laravel service provider & facade' },
  { name: 'Node.js SDK', icon: '🟢', desc: 'TypeScript & JavaScript npm client' },
  { name: 'Python SDK', icon: '🐍', desc: 'pip package for Python 3.8+' },
  { name: 'Ruby SDK', icon: '💎', desc: 'RubyGem with async support' },
  { name: 'Java SDK', icon: '☕', desc: 'Maven & Gradle client' },
  { name: '.NET SDK', icon: '🔷', desc: 'NuGet package for .NET 6/8' },
  { name: 'CLI Tool', icon: '💻', desc: 'Cross-platform CLI binary' },
];

const INTEGRATIONS = [
  {
    name: 'Zapier',
    desc: 'Connect EasyConvert with 5,000+ apps and create automated workflows using a graphical interface.',
  },
  {
    name: 'Microsoft Power Automate',
    desc: 'Build automated cloud flows. Automate repetitive conversion tasks with enterprise integrations.',
  },
  {
    name: 'Make (formerly Integromat)',
    desc: 'Drag and drop desired apps together to build complex multi-step pipelines without writing code.',
  },
  {
    name: 'n8n',
    desc: 'Fair-code workflow automation. Run self-hosted or cloud conversion pipelines.',
  },
  {
    name: 'MCP Server',
    desc: 'Model Context Protocol server for direct integration with AI coding agents and LLMs.',
  },
];

const SCOPES = [
  { category: 'User', scope: 'user.read', desc: 'Allows reading account data, remaining credits and usage metrics.' },
  { category: 'User', scope: 'user.write', desc: 'Allows updating account settings and notification preferences.' },
  { category: 'Tasks & Jobs', scope: 'task.read', desc: 'Allows reading job statuses and task outputs.' },
  { category: 'Tasks & Jobs', scope: 'task.write', desc: 'Allows creating, starting, and aborting conversion jobs.' },
  { category: 'Webhooks', scope: 'webhook.read', desc: 'Allows inspecting active webhook subscriptions.' },
  { category: 'Webhooks', scope: 'webhook.write', desc: 'Allows adding, modifying, and deleting webhook endpoints.' },
];

export default function ApiDocumentationPage() {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setIsSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const sampleJobPayload = `{
  "tasks": {
    "import-file": {
      "operation": "import/url",
      "url": "https://example.com/document.docx"
    },
    "convert-file": {
      "operation": "convert",
      "input": "import-file",
      "output_format": "pdf",
      "engine": "office"
    },
    "export-file": {
      "operation": "export/url",
      "input": "convert-file"
    }
  }
}`;

  const curlCreateJob = `curl -X POST https://api.easyconvert.com/v2/jobs \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${sampleJobPayload.replace(/\n/g, '').replace(/\s+/g, ' ')}'`;

  const sample422Payload = `{
  "message": "The given data was invalid.",
  "code": "INVALID_DATA",
  "errors": {
    "tasks": [
      "The tasks field is required."
    ]
  }
}`;

  const sample429Payload = `HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
Retry-After: 60

{
  "message": "Too many attempts",
  "code": "TOO_MANY_REQUESTS"
}`;

  return (
    <div className="min-h-screen bg-[#141414] text-neutral-100 flex flex-col font-sans">
      <Header />

      {/* Docs Sub-header */}
      <div className="border-b border-neutral-800 bg-[#181818]/80 backdrop-blur-md px-4 sm:px-8 py-3 flex items-center justify-between sticky top-16 z-30">
        <div className="flex items-center gap-3">
          <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-[#5C6BC0]/20 text-[#5C6BC0] border border-[#5C6BC0]/30">
            API v2
          </span>
          <span className="text-xs text-neutral-400 hidden sm:inline">
            RESTful Endpoints &amp; Client SDKs
          </span>
        </div>

        {/* Global Search Bar (⌘K) */}
        <div className="max-w-md w-full mx-4 hidden sm:block">
          <button
            type="button"
            onClick={() => setIsSearchOpen(true)}
            className="w-full flex items-center justify-between px-3.5 py-1.5 rounded-lg bg-neutral-900 border border-neutral-700 text-xs text-neutral-400 hover:border-neutral-600 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-neutral-500" />
              <span>Search endpoints, tasks, SDKs...</span>
            </div>
            <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px] text-neutral-400 font-mono border border-neutral-700">
              ⌘K
            </kbd>
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs font-semibold">
          <a
            href="/register"
            className="px-3.5 py-1.5 rounded-md bg-[#5C6BC0] hover:bg-[#4d5cb5] text-white transition-colors shadow-sm"
          >
            Get API Key
          </a>
        </div>
      </div>

      {/* 3-Column Docs Portal Layout */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-8 py-8">
        {/* Left Sidebar Navigation (3 cols) */}
        <aside className="hidden lg:block lg:col-span-3 sticky top-32 max-h-[calc(100vh-9rem)] overflow-y-auto pr-3 space-y-6 text-xs">
          <div>
            <div className="font-bold text-neutral-400 uppercase tracking-wider mb-2">
              Getting Started
            </div>
            <ul className="space-y-1">
              <li>
                <a
                  href="#introduction"
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[#5C6BC0]/15 text-[#5C6BC0] font-semibold border-l-2 border-[#5C6BC0]"
                >
                  Introduction
                </a>
              </li>
              <li>
                <a
                  href="#sdks"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  SDKs &amp; Libraries
                </a>
              </li>
              <li>
                <a
                  href="#integrations"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Integrations
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-neutral-400 uppercase tracking-wider mb-2">
              API Reference
            </div>
            <ul className="space-y-1">
              <li>
                <a
                  href="#base-url"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Base URL &amp; Regions
                </a>
              </li>
              <li>
                <a
                  href="#sandbox-api"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Sandbox API
                </a>
              </li>
              <li>
                <a
                  href="#terminology"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Terminology &amp; Tasks
                </a>
              </li>
              <li>
                <a
                  href="#authentication"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Authentication &amp; Scopes
                </a>
              </li>
              <li>
                <a
                  href="#errors-rate-limiting"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Errors &amp; Rate Limiting
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-neutral-400 uppercase tracking-wider mb-2">
              Operations
            </div>
            <ul className="space-y-1">
              <li>
                <a
                  href="/pdf-converter"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Convert Files
                </a>
              </li>
              <li>
                <a
                  href="/compress-pdf"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Optimize Files
                </a>
              </li>
              <li>
                <a
                  href="/merge-pdf"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Merge Files
                </a>
              </li>
              <li>
                <a
                  href="/save-website-as-pdf"
                  className="block px-2.5 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Capture Website
                </a>
              </li>
            </ul>
          </div>
        </aside>

        {/* Center Main Documentation Body (7 cols) */}
        <main className="lg:col-span-7 space-y-12">
          {/* Breadcrumb & Title */}
          <div id="introduction">
            <span className="text-xs font-semibold text-[#5C6BC0] uppercase tracking-wider">
              Getting Started &gt; API Documentation
            </span>
            <div className="flex items-center justify-between mt-2">
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                Welcome to the EasyConvert API
              </h1>
              <button
                type="button"
                onClick={() => copyToClipboard(typeof window !== 'undefined' ? window.location.href : '', 'page-url')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-neutral-700 bg-neutral-900 text-xs text-neutral-300 hover:text-white hover:border-neutral-600 transition-colors"
              >
                {copiedCode === 'page-url' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>Copy page</span>
              </button>
            </div>
            <p className="mt-4 text-neutral-300 text-sm leading-relaxed">
              Welcome to the EasyConvert API Documentation! This is the documentation for version 2 of the API (
              <code className="px-1.5 py-0.5 rounded bg-neutral-800 text-[#5C6BC0] font-mono text-xs">
                /v2
              </code>{' '}
              prefix).
            </p>
            <p className="mt-3 text-neutral-300 text-sm leading-relaxed">
              On this page, you will find general information about the terminology and about formatting and authenticating requests. You can use the menu on the left to jump directly to specific endpoint documentation.
            </p>
          </div>

          {/* Section: SDKs */}
          <section id="sdks" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">SDKs</h2>
            <p className="text-xs sm:text-sm text-neutral-400">
              For API v2, official PHP, Node.js, Python, Ruby, Java and .NET SDKs are available.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
              {SD_KS.map((sdk, i) => (
                <div
                  key={i}
                  className="p-4 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700 transition-all flex items-center justify-between group"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{sdk.icon}</span>
                    <div>
                      <h4 className="text-sm font-bold text-white group-hover:text-[#5C6BC0] transition-colors">
                        {sdk.name}
                      </h4>
                      <p className="text-[11px] text-neutral-400">{sdk.desc}</p>
                    </div>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300 transition-colors" />
                </div>
              ))}
            </div>
          </section>

          {/* Section: Integrations */}
          <section id="integrations" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">Integrations</h2>
            <p className="text-xs sm:text-sm text-neutral-400">
              Automate multi-app workflows without code using our pre-built integrations:
            </p>

            <div className="space-y-3 pt-2">
              {INTEGRATIONS.map((item, idx) => (
                <div key={idx} className="p-4 rounded-xl bg-neutral-900 border border-neutral-800">
                  <h4 className="text-sm font-bold text-white mb-1">{item.name}</h4>
                  <p className="text-xs text-neutral-400 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Section: Base URL and Region Endpoints */}
          <section id="base-url" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">
              Base URL and Region Endpoints
            </h2>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              The base URL of the API is{' '}
              <code className="px-1.5 py-0.5 rounded bg-neutral-800 text-[#5C6BC0] font-mono text-xs">
                https://api.easyconvert.com/v2
              </code>
              . By default, EasyConvert automatically selects the nearest processing region based on your IP address.
            </p>

            <div className="overflow-x-auto rounded-xl border border-neutral-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-900 text-white font-semibold border-b border-neutral-800">
                  <tr>
                    <th className="py-2.5 px-4">Endpoint</th>
                    <th className="py-2.5 px-4">Region</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 text-neutral-300">
                  <tr>
                    <td className="py-2.5 px-4 font-mono text-[#5C6BC0]">https://api.easyconvert.com</td>
                    <td className="py-2.5 px-4">Automatically selects the nearest processing region.</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-4 font-mono text-[#5C6BC0]">https://eu-central.api.easyconvert.com</td>
                    <td className="py-2.5 px-4">eu-central: Frankfurt, Germany</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-4 font-mono text-[#5C6BC0]">https://us-east.api.easyconvert.com</td>
                    <td className="py-2.5 px-4">us-east: Virginia, USA</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Section: Sandbox API */}
          <section id="sandbox-api" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">Sandbox API</h2>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              Besides the Live API, EasyConvert provides a Sandbox API. The sandbox environment allows you to execute unlimited test jobs and tasks without consuming your credits.
            </p>
            <div className="p-3.5 rounded-lg bg-neutral-900 border border-neutral-800 font-mono text-xs text-[#5C6BC0] flex items-center justify-between">
              <span>https://sandbox.api.easyconvert.com/v2</span>
              <button
                type="button"
                onClick={() => copyToClipboard('https://sandbox.api.easyconvert.com/v2', 'sandbox-url')}
                className="text-neutral-400 hover:text-white"
              >
                {copiedCode === 'sandbox-url' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </section>

          {/* Section: Terminology */}
          <section id="terminology" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">Terminology</h2>
            <div className="space-y-3 text-xs sm:text-sm text-neutral-300 leading-relaxed">
              <h3 className="text-base font-bold text-white">Jobs &amp; Tasks</h3>
              <p>
                Processing files is done via jobs in the EasyConvert REST API. Each job consists of one or more tasks.
                For example, the first task imports a file, the second converts it, and the third exports the result.
              </p>

              <div className="relative rounded-xl bg-neutral-950 border border-neutral-800 p-4 font-mono text-xs text-neutral-300 overflow-x-auto my-3">
                <button
                  type="button"
                  onClick={() => copyToClipboard(curlCreateJob, 'curl-sample')}
                  className="absolute right-3 top-3 text-neutral-400 hover:text-white p-1 rounded hover:bg-neutral-800"
                >
                  {copiedCode === 'curl-sample' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <pre className="text-neutral-300">{curlCreateJob}</pre>
              </div>

              <h3 className="text-base font-bold text-white pt-2">Import &amp; Export Tasks</h3>
              <p>
                An import task imports files into transient memory (e.g. from a URL or S3). Export tasks generate temporary download URLs or pipe bytes back to your bucket.
              </p>

              <h3 className="text-base font-bold text-white pt-2">Engine &amp; Engine Versions</h3>
              <p>
                Multiple engines are available for specific document types (e.g. LibreOffice, MuPDF, FFmpeg). You can pin specific engine versions to guarantee deterministic results.
              </p>
            </div>
          </section>

          {/* Section: Authentication */}
          <section id="authentication" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">Authentication</h2>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              Authenticate all requests using an API key passed in the{' '}
              <code className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-200 font-mono text-xs">
                Authorization: Bearer
              </code>{' '}
              header:
            </p>

            <div className="relative rounded-xl bg-neutral-950 border border-neutral-800 p-4 font-mono text-xs text-neutral-300">
              <code>Authorization: Bearer YOUR_API_KEY</code>
            </div>

            <h3 className="text-base font-bold text-white pt-3">Available Scopes</h3>
            <div className="overflow-x-auto rounded-xl border border-neutral-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-900 text-white font-semibold border-b border-neutral-800">
                  <tr>
                    <th className="py-2.5 px-4">Category</th>
                    <th className="py-2.5 px-4">Scope</th>
                    <th className="py-2.5 px-4">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 text-neutral-300">
                  {SCOPES.map((s, idx) => (
                    <tr key={idx}>
                      <td className="py-2.5 px-4 font-semibold text-white">{s.category}</td>
                      <td className="py-2.5 px-4 font-mono text-[#5C6BC0]">{s.scope}</td>
                      <td className="py-2.5 px-4 text-neutral-400">{s.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-base font-bold text-white pt-3">OAuth 2.0 Clients</h3>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              EasyConvert supports standard OAuth 2.0 authorization code and implicit grant flows to issue tokens on behalf of your users.
            </p>
          </section>

          {/* Section: Errors and Rate Limiting */}
          <section id="errors-rate-limiting" className="space-y-4 pt-6 border-t border-neutral-800">
            <h2 className="text-2xl font-bold text-white tracking-tight">
              Errors and Rate Limiting
            </h2>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              EasyConvert returns standard HTTP status codes (422, 500, 503, 429). Example 422 error payload:
            </p>

            <div className="rounded-xl bg-neutral-950 border border-neutral-800 p-4 font-mono text-xs text-neutral-300 overflow-x-auto">
              <pre>{sample422Payload}</pre>
            </div>

            <h3 className="text-base font-bold text-white pt-3">Rate Limiting</h3>
            <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
              Rate limits are returned in standard response headers. When rate limited, a 429 response is returned with a <code className="text-[#5C6BC0] font-mono">Retry-After</code> header:
            </p>

            <div className="rounded-xl bg-neutral-950 border border-neutral-800 p-4 font-mono text-xs text-neutral-300 overflow-x-auto">
              <pre>{sample429Payload}</pre>
            </div>
          </section>
        </main>

        {/* Right Sidebar ("On this page" TOC) (2 cols) */}
        <aside className="hidden lg:block lg:col-span-2 sticky top-32 max-h-[calc(100vh-9rem)] overflow-y-auto pl-2 border-l border-neutral-800 text-xs">
          <div className="font-bold text-neutral-400 uppercase tracking-wider mb-3">
            On this page
          </div>
          <ul className="space-y-2 text-neutral-400">
            <li>
              <a href="#introduction" className="hover:text-white transition-colors block">
                Introduction
              </a>
            </li>
            <li>
              <a href="#sdks" className="hover:text-white transition-colors block">
                SDKs
              </a>
            </li>
            <li>
              <a href="#integrations" className="hover:text-white transition-colors block">
                Integrations
              </a>
            </li>
            <li>
              <a href="#base-url" className="hover:text-white transition-colors block">
                Base URL &amp; Regions
              </a>
            </li>
            <li>
              <a href="#sandbox-api" className="hover:text-white transition-colors block">
                Sandbox API
              </a>
            </li>
            <li>
              <a href="#terminology" className="hover:text-white transition-colors block">
                Terminology
              </a>
            </li>
            <li>
              <a href="#authentication" className="hover:text-white transition-colors block">
                Authentication
              </a>
            </li>
            <li>
              <a href="#errors-rate-limiting" className="hover:text-white transition-colors block">
                Errors &amp; Rate Limiting
              </a>
            </li>
          </ul>
        </aside>
      </div>

      {/* Global ⌘K Modal */}
      {isSearchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setIsSearchOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl overflow-hidden animate-in fade-in duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-neutral-800 flex items-center gap-2">
              <Search className="w-4 h-4 text-neutral-400" />
              <input
                type="text"
                autoFocus
                placeholder="Search API documentation..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-sm text-white focus:outline-none placeholder-neutral-500"
              />
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px] text-neutral-400 font-mono border border-neutral-700">
                ESC
              </kbd>
            </div>
            <div className="p-3 max-h-64 overflow-y-auto space-y-1 text-xs text-neutral-300">
              <a
                href="#sdks"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                SDKs &amp; Client Libraries
              </a>
              <a
                href="#integrations"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                Third-Party Integrations
              </a>
              <a
                href="#authentication"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                Authentication &amp; API Keys
              </a>
              <a
                href="#terminology"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                Jobs &amp; Tasks Workflow
              </a>
              <a
                href="#base-url"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                Base URL &amp; Sandbox Endpoint
              </a>
              <a
                href="#errors-rate-limiting"
                onClick={() => setIsSearchOpen(false)}
                className="block p-2 rounded-lg hover:bg-neutral-800 hover:text-white transition-colors"
              >
                Errors &amp; Rate Limiting Headers
              </a>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
