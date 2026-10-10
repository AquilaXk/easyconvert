'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  Code2,
  Search,
  Copy,
  Check,
  Download,
  ExternalLink,
  Shield,
  Tag,
  ChevronDown,
  ChevronRight,
  Terminal,
  Layers,
  Sparkles,
  AlertCircle,
  FileCode,
} from 'lucide-react';

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    example?: string | number | boolean;
    default?: string | number | boolean;
  };
}

interface OpenApiMediaType {
  schema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; description?: string; format?: string }>;
    $ref?: string;
  };
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: { name?: string; url?: string };
    license?: { name?: string; url?: string };
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const METHOD_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  get: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  post: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  put: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  patch: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  delete: { bg: 'bg-rose-500/10', text: 'text-rose-400', border: 'border-rose-500/30' },
};

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<string>('all');
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');

  useEffect(() => {
    async function loadSpec() {
      try {
        setLoading(true);
        const res = await fetch('/api/v1/openapi.json');
        if (!res.ok) {
          throw new Error(`Failed to load OpenAPI spec (${res.status} ${res.statusText})`);
        }
        const data: OpenApiSpec = await res.json();
        setSpec(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unknown error loading OpenAPI specification');
      } finally {
        setLoading(false);
      }
    }
    loadSpec();
  }, []);

  const toggleEndpoint = (key: string) => {
    setExpandedEndpoints((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const parsedEndpoints = useMemo(() => {
    if (!spec?.paths) return [];
    const list: Array<{
      key: string;
      path: string;
      method: string;
      operation: OpenApiOperation;
    }> = [];

    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of methods) {
        const operation = pathItem[method];
        if (operation) {
          list.push({
            key: `${method.toUpperCase()}:${path}`,
            path,
            method: method.toLowerCase(),
            operation,
          });
        }
      }
    }
    return list;
  }, [spec]);

  const filteredEndpoints = useMemo(() => {
    return parsedEndpoints.filter((item) => {
      const matchMethod = selectedMethod === 'all' || item.method === selectedMethod;
      const q = searchQuery.toLowerCase().trim();
      if (!q) return matchMethod;

      const matchPath = item.path.toLowerCase().includes(q);
      const matchSummary = item.operation.summary?.toLowerCase().includes(q) ?? false;
      const matchDesc = item.operation.description?.toLowerCase().includes(q) ?? false;
      const matchTags = item.operation.tags?.some((t) => t.toLowerCase().includes(q)) ?? false;

      return matchMethod && (matchPath || matchSummary || matchDesc || matchTags);
    });
  }, [parsedEndpoints, selectedMethod, searchQuery]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Hero Section */}
        <div className="relative mb-10 pb-8 border-b border-slate-800">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-3">
                <Sparkles className="w-3.5 h-3.5" />
                OpenAPI 3.1 Specification
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                {spec?.info.title || 'EasyConvert Developer API'}
              </h1>
              <p className="mt-2 text-sm sm:text-base text-slate-400 max-w-3xl leading-relaxed">
                {spec?.info.description ||
                  'High-performance REST API for asynchronous conversion queues, zero-heap streaming, and enterprise webhooks.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-400">
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
                  <Tag className="w-3.5 h-3.5 text-indigo-400" />
                  Version: <strong className="text-slate-200">{spec?.info.version || '1.0.0'}</strong>
                </span>
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  Auth: <strong className="text-slate-200">API Key / Bearer Token</strong>
                </span>
                {spec?.servers?.[0] && (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
                    <Layers className="w-3.5 h-3.5 text-blue-400" />
                    Base: <strong className="text-slate-200">{spec.servers[0].url}</strong>
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <a
                href="/api/v1/openapi.json"
                download="openapi.json"
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors shadow-lg shadow-indigo-600/20"
              >
                <Download className="w-4 h-4" />
                Download OpenAPI JSON
              </a>
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-medium text-sm transition-colors"
              >
                <Code2 className="w-4 h-4" />
                API Key Dashboard
              </Link>
            </div>
          </div>

          {/* Quick API Key Tester Bar */}
          <div className="mt-6 p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300 whitespace-nowrap">
              <Terminal className="w-4 h-4 text-indigo-400" />
              Quick cURL Tester Key:
            </div>
            <input
              type="text"
              placeholder="Paste your api_live_... key to preview live commands"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              className="flex-1 px-3 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>

        {/* Filter Controls */}
        <div className="mb-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Search endpoints (e.g. convert, jobs, status)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-900/80 border border-slate-800 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            {['all', 'get', 'post', 'delete'].map((method) => {
              const active = selectedMethod === method;
              return (
                <button
                  key={method}
                  onClick={() => setSelectedMethod(method)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                    active
                      ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  {method}
                </button>
              );
            })}
          </div>
        </div>

        {/* Loading / Error States */}
        {loading && (
          <div className="py-20 text-center">
            <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-slate-400 text-sm">Loading OpenAPI specification...</p>
          </div>
        )}

        {error && (
          <div className="p-6 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-sm">Failed to Load OpenAPI Specification</h3>
              <p className="text-xs text-rose-400 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Endpoints List */}
        {!loading && !error && (
          <div className="space-y-4">
            {filteredEndpoints.length === 0 ? (
              <div className="py-16 text-center rounded-xl bg-slate-900/40 border border-slate-800">
                <FileCode className="w-8 h-8 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-400 text-sm">No matching API endpoints found.</p>
              </div>
            ) : (
              filteredEndpoints.map(({ key, path, method, operation }) => {
                const isExpanded = !!expandedEndpoints[key];
                const methodColor = METHOD_COLORS[method] || {
                  bg: 'bg-slate-800',
                  text: 'text-slate-300',
                  border: 'border-slate-700',
                };
                const effectiveKey = apiKeyInput.trim() || 'YOUR_API_KEY';
                const curlSnippet =
                  method === 'post'
                    ? `curl -X POST https://easyconvert.app${path} \\\n  -H "Authorization: Bearer ${effectiveKey}" \\\n  -F "file=@sample.docx" \\\n  -F "targetFormat=pdf"`
                    : `curl -X GET "https://easyconvert.app${path}" \\\n  -H "Authorization: Bearer ${effectiveKey}"`;

                return (
                  <div
                    key={key}
                    className="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden transition-all hover:border-slate-700/80"
                  >
                    {/* Header Bar */}
                    <button
                      onClick={() => toggleEndpoint(key)}
                      className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-900/70 transition-colors focus:outline-none"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <span
                          className={`px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider border ${methodColor.bg} ${methodColor.text} ${methodColor.border}`}
                        >
                          {method}
                        </span>
                        <span className="font-mono text-sm sm:text-base font-semibold text-slate-100 truncate">
                          {path}
                        </span>
                        {operation.summary && (
                          <span className="hidden md:inline-block text-xs text-slate-400 truncate max-w-md">
                            — {operation.summary}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 text-slate-500">
                        {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </div>
                    </button>

                    {/* Collapsible Content */}
                    {isExpanded && (
                      <div className="px-5 pb-6 pt-2 border-t border-slate-800/60 space-y-6">
                        {operation.description && (
                          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                            {operation.description}
                          </p>
                        )}

                        {/* Security Requirements */}
                        {operation.security && operation.security.length > 0 && (
                          <div>
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <Shield className="w-3.5 h-3.5 text-indigo-400" />
                              Security & Scopes
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {operation.security.flatMap((sec) =>
                                Object.entries(sec).map(([scheme, scopes]) => (
                                  <span
                                    key={scheme}
                                    className="px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300"
                                  >
                                    <strong>{scheme}</strong>
                                    {scopes.length > 0 && ` (${scopes.join(', ')})`}
                                  </span>
                                ))
                              )}
                            </div>
                          </div>
                        )}

                        {/* Request Parameters */}
                        {operation.parameters && operation.parameters.length > 0 && (
                          <div>
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                              Parameters
                            </h4>
                            <div className="rounded-lg border border-slate-800 overflow-x-auto">
                              <table className="w-full text-left text-xs">
                                <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                                  <tr>
                                    <th className="px-4 py-2 font-medium">Name</th>
                                    <th className="px-4 py-2 font-medium">In</th>
                                    <th className="px-4 py-2 font-medium">Type</th>
                                    <th className="px-4 py-2 font-medium">Required</th>
                                    <th className="px-4 py-2 font-medium">Description</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/60 bg-slate-900/30">
                                  {operation.parameters.map((p) => (
                                    <tr key={`${p.in}-${p.name}`} className="hover:bg-slate-900/50">
                                      <td className="px-4 py-2.5 font-mono text-indigo-300 font-semibold">
                                        {p.name}
                                      </td>
                                      <td className="px-4 py-2.5 text-slate-400">{p.in}</td>
                                      <td className="px-4 py-2.5 font-mono text-slate-400">
                                        {p.schema?.type || 'string'}
                                      </td>
                                      <td className="px-4 py-2.5">
                                        {p.required ? (
                                          <span className="text-rose-400 font-bold">Yes</span>
                                        ) : (
                                          <span className="text-slate-500">No</span>
                                        )}
                                      </td>
                                      <td className="px-4 py-2.5 text-slate-300">{p.description || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Request Body */}
                        {operation.requestBody?.content && (
                          <div>
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                              Request Body
                            </h4>
                            <div className="space-y-3">
                              {Object.entries(operation.requestBody.content).map(([contentType, media]) => (
                                <div
                                  key={contentType}
                                  className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
                                >
                                  <div className="font-mono text-indigo-300 font-medium mb-2">
                                    Content-Type: <code>{contentType}</code>
                                  </div>
                                  {media.schema?.properties ? (
                                    <div className="space-y-1.5 mt-2">
                                      {Object.entries(media.schema.properties).map(([propName, propDef]) => (
                                        <div key={propName} className="flex items-start gap-2">
                                          <span className="font-mono text-slate-200 font-semibold">
                                            {propName}
                                            {media.schema?.required?.includes(propName) && (
                                              <span className="text-rose-400 ml-0.5">*</span>
                                            )}
                                            :
                                          </span>
                                          <span className="font-mono text-slate-400 text-[11px]">
                                            [{propDef.type || 'any'}]
                                          </span>
                                          <span className="text-slate-400">{propDef.description}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="text-slate-500 italic">Binary or structured payload.</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Interactive cURL Snippet */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                              <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                              Executable cURL
                            </h4>
                            <button
                              onClick={() => copyToClipboard(curlSnippet, `curl-${key}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                            >
                              {copiedKey === `curl-${key}` ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  Copy cURL
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
                            {curlSnippet}
                          </pre>
                        </div>

                        {/* Responses */}
                        {operation.responses && (
                          <div>
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                              Responses
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {Object.entries(operation.responses).map(([statusCode, resp]) => {
                                const isSuccess = statusCode.startsWith('2');
                                const isClientErr = statusCode.startsWith('4');
                                const badgeColor = isSuccess
                                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                                  : isClientErr
                                  ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                                  : 'text-rose-400 bg-rose-500/10 border-rose-500/20';

                                return (
                                  <div
                                    key={statusCode}
                                    className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between"
                                  >
                                    <div className="flex items-center gap-2 mb-1">
                                      <span
                                        className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono border ${badgeColor}`}
                                      >
                                        {statusCode}
                                      </span>
                                    </div>
                                    <p className="text-xs text-slate-400 line-clamp-2">{resp.description}</p>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
