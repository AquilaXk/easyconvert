'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import type { User } from '@/lib/auth/types';
import type { ApiKey, QuotaUsage, UserConversionFile } from '@/lib/api-keys/types';
import {
  Key,
  FileText,
  Shield,
  Copy,
  Check,
  Trash2,
  Plus,
  Clock,
  Download,
  AlertTriangle,
  RefreshCw,
  LogOut,
  Layers,
  Code2,
  Terminal,
  ExternalLink,
  Loader2,
} from 'lucide-react';

interface FileWithRemaining extends UserConversionFile {
  remainingSeconds: number;
}

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'api' | 'files' | 'plans'>('api');
  const [loading, setLoading] = useState(true);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState<QuotaUsage | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [codeTab, setCodeTab] = useState<'curl' | 'node' | 'python'>('curl');

  // Files state
  const [userFiles, setUserFiles] = useState<FileWithRemaining[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Fetch initial profile
  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        router.push('/auth');
        return;
      }
      const data = await res.json();
      if (data.success && data.user) {
        setUser(data.user);
      } else {
        router.push('/auth');
      }
    } catch {
      router.push('/auth');
    } finally {
      setLoading(false);
    }
  }, [router]);

  // Fetch API keys and quota
  const fetchKeysAndQuota = useCallback(async () => {
    try {
      const [keysRes, quotaRes] = await Promise.all([
        fetch('/api/keys'),
        fetch('/api/keys/usage'),
      ]);

      if (keysRes.ok) {
        const keysData = await keysRes.json();
        if (keysData.success) setApiKeys(keysData.keys);
      }

      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        if (quotaData.success) setQuota(quotaData.usage);
      }
    } catch {
      // Ignore background refresh errors
    }
  }, []);

  // Fetch conversion files
  const fetchUserFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await fetch('/api/account/files');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setUserFiles(data.files);
        }
      }
    } catch {
      // Ignore
    } finally {
      setFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (user) {
      fetchKeysAndQuota();
      fetchUserFiles();
    }
  }, [user, fetchKeysAndQuota, fetchUserFiles]);

  // 1-second interval to decrement remaining countdown for files
  useEffect(() => {
    const timer = setInterval(() => {
      setUserFiles((prev) =>
        prev
          .map((f) => ({
            ...f,
            remainingSeconds: Math.max(0, f.remainingSeconds - 1),
          }))
          .filter((f) => f.remainingSeconds > 0)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/auth');
    router.refresh();
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGeneratingKey(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName || 'Production API Key' }),
      });
      const data = await res.json();
      if (data.success && data.secretKey) {
        setGeneratedSecret(data.secretKey);
        setNewKeyName('');
        await fetchKeysAndQuota();
      }
    } catch {
      // Ignore
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key? Any applications using it will be denied access.')) {
      return;
    }
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchKeysAndQuota();
      }
    } catch {
      // Ignore
    }
  };

  const handleDeleteFile = async (id: string) => {
    try {
      const res = await fetch(`/api/account/files/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setUserFiles((prev) => prev.filter((f) => f.id !== id));
      }
    } catch {
      // Ignore
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-brand-700 dark:text-brand-400" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const sampleKeyDisplay = apiKeys.length > 0 ? apiKeys[0].prefix : 'ec_live_your_api_key_here';

  const codeSnippets = {
    curl: `curl -X POST https://easyconvert.app/api/v1/convert \\
  -H "Authorization: Bearer ${sampleKeyDisplay}" \\
  -F "file=@document.docx" \\
  -F "targetFormat=pdf"`,
    node: `import fs from 'node:fs';

const formData = new FormData();
formData.append('file', new Blob([fs.readFileSync('document.docx')]), 'document.docx');
formData.append('targetFormat', 'pdf');

const res = await fetch('https://easyconvert.app/api/v1/convert', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${sampleKeyDisplay}',
  },
  body: formData,
});

const result = await res.json();
console.log('Converted File URL:', result.dataUri);`,
    python: `import requests

url = "https://easyconvert.app/api/v1/convert"
headers = {"Authorization": "Bearer ${sampleKeyDisplay}"}
files = {"file": open("document.docx", "rb")}
data = {"targetFormat": "pdf"}

response = requests.post(url, headers=headers, files=files, data=data)
print(response.json())`,
  };

  return (
    <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold flex flex-col text-ink-primary dark:text-white">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* User Profile Header Card */}
        <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-8 shadow-sm mb-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-tr from-brand-700 to-brand-500 text-white flex items-center justify-center text-2xl font-bold shadow-md shadow-brand-700/20 shrink-0">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  className="w-full h-full object-cover rounded-2xl"
                />
              ) : (
                <span>{user.name.charAt(0).toUpperCase()}</span>
              )}
            </div>

            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{user.name}</h1>
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-300/40 dark:border-white/10">
                  <Shield className="w-3.5 h-3.5" />
                  {user.tier.toUpperCase()} TIER
                </span>
              </div>
              <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1">{user.email}</p>
              <div className="flex items-center gap-3 text-xs text-ink-muted dark:text-dark-muted mt-2">
                <span>Auth Provider: <strong className="capitalize">{user.provider}</strong></span>
                <span>•</span>
                <span>Member since: {new Date(user.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-ink-primary dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-dark-elevated text-sm font-medium transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>

        {/* Dashboard Navigation Tabs */}
        <div className="flex border-b border-neutral-border dark:border-dark-border mb-8 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('api')}
            className={`flex items-center gap-2 px-5 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'api'
                ? 'border-brand-700 text-brand-700 dark:text-brand-400 dark:border-brand-400'
                : 'border-transparent text-ink-secondary dark:text-dark-muted hover:text-ink-primary dark:hover:text-white'
            }`}
          >
            <Key className="w-4 h-4" />
            <span>Developer API Keys</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('files')}
            className={`flex items-center gap-2 px-5 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'files'
                ? 'border-brand-700 text-brand-700 dark:text-brand-400 dark:border-brand-400'
                : 'border-transparent text-ink-secondary dark:text-dark-muted hover:text-ink-primary dark:hover:text-white'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>My Converted Files</span>
            {userFiles.length > 0 && (
              <span className="ml-1.5 px-2 py-0.5 text-xs rounded-full bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
                {userFiles.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('plans')}
            className={`flex items-center gap-2 px-5 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'plans'
                ? 'border-brand-700 text-brand-700 dark:text-brand-400 dark:border-brand-400'
                : 'border-transparent text-ink-secondary dark:text-dark-muted hover:text-ink-primary dark:hover:text-white'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Plan & Quotas</span>
          </button>
        </div>

        {/* Tab 1: API Keys & Quota */}
        {activeTab === 'api' && (
          <div className="space-y-8">
            {/* Daily Quota Summary Card */}
            {quota && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 shadow-sm">
                  <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
                    Daily Conversions Used
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-brand-700 dark:text-brand-300">
                      {quota.usedToday}
                    </span>
                    <span className="text-ink-muted dark:text-dark-muted text-sm">
                      / {quota.dailyLimit} allowed
                    </span>
                  </div>
                  <div className="mt-4 w-full bg-neutral-subtle dark:bg-dark-elevated rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-brand-700 dark:bg-brand-500 h-2.5 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(100, (quota.usedToday / quota.dailyLimit) * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 shadow-sm">
                  <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
                    Remaining Quota
                  </div>
                  <div className="mt-2 text-3xl font-bold text-ink-primary dark:text-white">
                    {quota.remaining} <span className="text-sm font-normal text-ink-muted">calls left</span>
                  </div>
                  <p className="mt-3 text-xs text-ink-muted dark:text-dark-muted">
                    Instant REST access with guaranteed zero cloud retention.
                  </p>
                </div>

                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 shadow-sm">
                  <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
                    Daily Reset
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xl font-bold text-ink-primary dark:text-white">
                    <Clock className="w-5 h-5 text-brand-700 dark:text-brand-400" />
                    <span>00:00 UTC</span>
                  </div>
                  <p className="mt-3 text-xs text-ink-muted dark:text-dark-muted">
                    Counters automatically reset each day at midnight UTC.
                  </p>
                </div>
              </div>
            )}

            {/* Generated Key Reveal Alert */}
            {generatedSecret && (
              <div className="bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-500/50 rounded-2xl p-6 shadow-md">
                <div className="flex items-start gap-4">
                  <div className="p-2 rounded-xl bg-emerald-500 text-white shrink-0">
                    <Check className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-bold text-emerald-900 dark:text-emerald-300">
                      API Key Generated Successfully
                    </h3>
                    <p className="text-xs text-emerald-800/80 dark:text-emerald-400/80 mt-1">
                      Please copy this secret key now. For your security, this key will never be shown again!
                    </p>

                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={generatedSecret}
                        className="font-mono text-sm px-4 py-2.5 rounded-xl bg-white dark:bg-dark-surface border border-emerald-500/40 text-emerald-950 dark:text-emerald-200 flex-1 outline-none select-all"
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(generatedSecret)}
                        className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm flex items-center gap-2 shrink-0 transition-colors shadow-sm"
                      >
                        {copiedKey ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        <span>{copiedKey ? 'Copied!' : 'Copy Key'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setGeneratedSecret(null)}
                        className="px-3 py-2.5 rounded-xl border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Key Management Card */}
            <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 sm:p-8 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-bold">API Secret Keys</h2>
                  <p className="text-sm text-ink-secondary dark:text-dark-muted">
                    Authenticate automated conversion scripts and backend servers
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowGenerateModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm shadow-md shadow-brand-700/20 transition-all self-start sm:self-auto"
                >
                  <Plus className="w-4 h-4" />
                  <span>Generate New Key</span>
                </button>
              </div>

              {/* Generate Key Modal */}
              {showGenerateModal && (
                <div className="mb-6 p-5 rounded-2xl bg-neutral-subtle dark:bg-dark-elevated border border-neutral-border dark:border-dark-border">
                  <h3 className="text-sm font-bold mb-2">Create New API Key</h3>
                  <form onSubmit={handleGenerateKey} className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      required
                      placeholder="e.g. Production Backend Worker"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-sm focus:outline-none focus:ring-2 focus:ring-brand-700"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={isGeneratingKey}
                        className="px-5 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm flex items-center gap-2 disabled:opacity-60"
                      >
                        {isGeneratingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                        <span>Create</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowGenerateModal(false)}
                        className="px-4 py-2.5 rounded-xl border border-neutral-border dark:border-dark-border text-sm hover:bg-neutral-border/40"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* Keys Table */}
              {apiKeys.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-neutral-border dark:border-dark-border rounded-2xl">
                  <Key className="w-10 h-10 text-ink-muted dark:text-dark-muted mx-auto mb-3" />
                  <p className="text-sm font-semibold">No API keys created yet</p>
                  <p className="text-xs text-ink-muted dark:text-dark-muted mt-1">
                    Generate an API key to start making programmatic conversion requests.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
                        <th className="pb-3 font-semibold">Name</th>
                        <th className="pb-3 font-semibold">Key Prefix</th>
                        <th className="pb-3 font-semibold">Created</th>
                        <th className="pb-3 font-semibold">Last Used</th>
                        <th className="pb-3 font-semibold">Status</th>
                        <th className="pb-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
                      {apiKeys.map((key) => {
                        const isActive = key.status === 'active';
                        return (
                          <tr key={key.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                            <td className="py-4 font-semibold text-ink-primary dark:text-white">
                              {key.name}
                            </td>
                            <td className="py-4 font-mono text-xs text-ink-secondary dark:text-dark-muted">
                              {key.prefix}
                            </td>
                            <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                              {new Date(key.createdAt).toLocaleDateString()}
                            </td>
                            <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                              {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                            </td>
                            <td className="py-4">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                                  isActive
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                                    : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20'
                                }`}
                              >
                                {key.status.toUpperCase()}
                              </span>
                            </td>
                            <td className="py-4 text-right">
                              {isActive ? (
                                <button
                                  type="button"
                                  onClick={() => handleRevokeKey(key.id)}
                                  className="text-xs text-status-danger hover:underline font-medium"
                                >
                                  Revoke
                                </button>
                              ) : (
                                <span className="text-xs text-ink-muted">Revoked</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* REST API Quickstart & Code Examples */}
            <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 sm:p-8 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
                    <Code2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold">Programmatic Integration Guide</h2>
                    <p className="text-xs text-ink-secondary dark:text-dark-muted">
                      Seamlessly convert documents, media, cad, and spreadsheets using standard HTTP multipart requests
                    </p>
                  </div>
                </div>

                <div className="flex rounded-lg bg-neutral-subtle dark:bg-dark-elevated p-1 border border-neutral-border dark:border-dark-border">
                  <button
                    type="button"
                    onClick={() => setCodeTab('curl')}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                      codeTab === 'curl'
                        ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
                        : 'text-ink-secondary dark:text-dark-muted'
                    }`}
                  >
                    cURL
                  </button>
                  <button
                    type="button"
                    onClick={() => setCodeTab('node')}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                      codeTab === 'node'
                        ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
                        : 'text-ink-secondary dark:text-dark-muted'
                    }`}
                  >
                    Node.js
                  </button>
                  <button
                    type="button"
                    onClick={() => setCodeTab('python')}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                      codeTab === 'python'
                        ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
                        : 'text-ink-secondary dark:text-dark-muted'
                    }`}
                  >
                    Python
                  </button>
                </div>
              </div>

              <div className="relative mt-4">
                <pre className="p-4 rounded-xl bg-ink-primary dark:bg-dark-scaffold text-neutral-subtle font-mono text-xs overflow-x-auto leading-relaxed border border-dark-border">
                  {codeSnippets[codeTab]}
                </pre>
                <button
                  type="button"
                  onClick={() => copyToClipboard(codeSnippets[codeTab])}
                  className="absolute top-3 right-3 p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title="Copy Code"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: My Converted Files */}
        {activeTab === 'files' && (
          <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 sm:p-8 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h2 className="text-lg font-bold">Recent Conversion Files</h2>
                <p className="text-sm text-ink-secondary dark:text-dark-muted">
                  Files are automatically purged 1 hour after conversion to guarantee zero data retention.
                </p>
              </div>

              <button
                type="button"
                onClick={fetchUserFiles}
                disabled={filesLoading}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-neutral-border dark:border-dark-border text-xs font-medium hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors self-start sm:self-auto"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${filesLoading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            {userFiles.length === 0 ? (
              <div className="text-center py-16 border-2 border-dashed border-neutral-border dark:border-dark-border rounded-2xl">
                <FileText className="w-12 h-12 text-ink-muted dark:text-dark-muted mx-auto mb-3" />
                <p className="text-base font-semibold">No recent conversion files</p>
                <p className="text-xs text-ink-muted dark:text-dark-muted mt-1 max-w-sm mx-auto">
                  Files you convert programmatically or through the web interface will appear here with an active 1-hour expiration countdown.
                </p>
                <a
                  href="/"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold shadow-sm"
                >
                  <span>Start Converting Files</span>
                </a>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
                      <th className="pb-3 font-semibold">File Name</th>
                      <th className="pb-3 font-semibold">Format</th>
                      <th className="pb-3 font-semibold">Size</th>
                      <th className="pb-3 font-semibold">Auto-Purge Expiration</th>
                      <th className="pb-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
                    {userFiles.map((file) => (
                      <tr key={file.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                        <td className="py-4 font-semibold text-ink-primary dark:text-white">
                          {file.fileName}
                        </td>
                        <td className="py-4">
                          <span className="inline-flex items-center gap-1 font-mono text-xs font-medium px-2 py-0.5 rounded bg-brand-100 dark:bg-white/10 text-brand-800 dark:text-brand-300">
                            {file.fromFormat.toUpperCase()} &rarr; {file.toFormat.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                          {formatBytes(file.size)}
                        </td>
                        <td className="py-4 text-xs font-medium">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                            <Clock className="w-3.5 h-3.5" />
                            {formatCountdown(file.remainingSeconds)}
                          </span>
                        </td>
                        <td className="py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <a
                              href={file.downloadUrl}
                              download={file.fileName}
                              className="p-2 rounded-lg bg-brand-700 text-white hover:bg-brand-800 transition-colors shadow-sm"
                              title="Download File"
                            >
                              <Download className="w-4 h-4" />
                            </a>
                            <button
                              type="button"
                              onClick={() => handleDeleteFile(file.id)}
                              className="p-2 rounded-lg border border-neutral-border dark:border-dark-border text-ink-muted hover:text-status-danger transition-colors"
                              title="Delete Now"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Plans & Quotas */}
        {activeTab === 'plans' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Free Tier */}
            <div className={`rounded-3xl p-8 border ${user.tier === 'free' ? 'border-brand-700 ring-2 ring-brand-700/20' : 'border-neutral-border dark:border-dark-border'} bg-white dark:bg-dark-surface shadow-sm flex flex-col justify-between`}>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold">Free Tier</h3>
                  {user.tier === 'free' && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
                      CURRENT PLAN
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold">$0</span>
                  <span className="text-ink-muted text-sm">/ forever</span>
                </div>
                <p className="mt-2 text-xs text-ink-secondary dark:text-dark-muted">
                  Essential tools for occasional and personal conversions.
                </p>

                <ul className="mt-6 space-y-3 text-sm text-ink-secondary dark:text-dark-muted">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>25 daily conversions</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Up to 100 MB per file</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Full REST API Key access</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Zero-retention privacy storage</span>
                  </li>
                </ul>
              </div>

              <div className="mt-8">
                <button
                  type="button"
                  disabled
                  className="w-full py-2.5 rounded-xl border border-neutral-border dark:border-dark-border text-ink-muted text-sm font-semibold opacity-70"
                >
                  Active Plan
                </button>
              </div>
            </div>

            {/* Pro Tier */}
            <div className={`rounded-3xl p-8 border ${user.tier === 'pro' ? 'border-brand-700 ring-2 ring-brand-700/20' : 'border-neutral-border dark:border-dark-border'} bg-white dark:bg-dark-surface shadow-sm flex flex-col justify-between`}>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold">Pro Developer</h3>
                  {user.tier === 'pro' && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
                      CURRENT PLAN
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold">$12</span>
                  <span className="text-ink-muted text-sm">/ month</span>
                </div>
                <p className="mt-2 text-xs text-ink-secondary dark:text-dark-muted">
                  High-throughput workflows for developers and power users.
                </p>

                <ul className="mt-6 space-y-3 text-sm text-ink-secondary dark:text-dark-muted">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>500 daily conversions</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Priority container worker queue</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>High-volume OCR & Office conversions</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Dedicated high-bandwidth endpoint</span>
                  </li>
                </ul>
              </div>

              <div className="mt-8">
                <button
                  type="button"
                  className="w-full py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold shadow-md shadow-brand-700/20 transition-colors"
                >
                  Upgrade to Pro
                </button>
              </div>
            </div>

            {/* Enterprise Tier */}
            <div className={`rounded-3xl p-8 border ${user.tier === 'enterprise' ? 'border-brand-700 ring-2 ring-brand-700/20' : 'border-neutral-border dark:border-dark-border'} bg-white dark:bg-dark-surface shadow-sm flex flex-col justify-between`}>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold">Enterprise</h3>
                  {user.tier === 'enterprise' && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300">
                      CURRENT PLAN
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold">$89</span>
                  <span className="text-ink-muted text-sm">/ month</span>
                </div>
                <p className="mt-2 text-xs text-ink-secondary dark:text-dark-muted">
                  Custom conversion infrastructure for enterprise workloads.
                </p>

                <ul className="mt-6 space-y-3 text-sm text-ink-secondary dark:text-dark-muted">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>10,000+ daily conversions</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Custom private engines & fonts</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>99.9% Uptime SLA</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>Dedicated integration support</span>
                  </li>
                </ul>
              </div>

              <div className="mt-8">
                <button
                  type="button"
                  className="w-full py-2.5 rounded-xl border border-brand-700 text-brand-700 dark:text-brand-400 text-sm font-semibold hover:bg-brand-50 dark:hover:bg-white/5 transition-colors"
                >
                  Contact Sales
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
