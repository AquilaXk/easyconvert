'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import type { User } from '@/lib/auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage, UserConversionFile, WebhookDlqEntry } from '@/lib/api-keys/types';

const TAB_LABELS: Record<'curl' | 'node' | 'python', string> = {
  curl: 'cURL',
  node: 'Node.js',
  python: 'Python',
};
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
  RefreshCw,
  LogOut,
  Layers,
  Code2,
  Loader2,
  Send,
  Inbox,
  Eye,
  Play,
} from 'lucide-react';

interface FileWithRemaining extends UserConversionFile {
  remainingSeconds: number;
}

interface IntegrationGuideProps {
  sampleKeyDisplay: string;
  copyToClipboard: (text: string) => void;
}

function IntegrationGuide({ sampleKeyDisplay, copyToClipboard }: Readonly<IntegrationGuideProps>) {
  const [codeTab, setCodeTab] = useState<'curl' | 'node' | 'python'>('curl');

  const codeSnippets = {
    curl: String.raw`curl -X POST https://easyconvert.app/api/v1/convert \
  -H "Authorization: Bearer ${sampleKeyDisplay}" \
  -F "file=@document.docx" \
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
          {(['curl', 'node', 'python'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setCodeTab(tab)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                codeTab === tab
                  ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
                  : 'text-ink-secondary dark:text-dark-muted'
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
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
  );
}

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'api' | 'files' | 'dlq' | 'plans'>('api');
  const [loading, setLoading] = useState(true);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState<QuotaUsage | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([
    'convert:write',
    'convert:read',
    'storage:download',
  ]);
  const [keyExpiry, setKeyExpiry] = useState<'30d' | '60d' | '90d' | '1y' | 'never'>('30d');

  // Files state
  const [userFiles, setUserFiles] = useState<FileWithRemaining[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // DLQ state
  const [dlqEntries, setDlqEntries] = useState<WebhookDlqEntry[]>([]);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [inspectingDlq, setInspectingDlq] = useState<WebhookDlqEntry | null>(null);
  const [replayingDlqId, setReplayingDlqId] = useState<string | null>(null);
  const [dlqFeedback, setDlqFeedback] = useState<string | null>(null);

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

  // Fetch Webhook DLQ entries
  const fetchDlqEntries = useCallback(async () => {
    setDlqLoading(true);
    try {
      const res = await fetch('/api/webhooks/dlq');
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.entries)) {
          setDlqEntries(data.entries);
        }
      }
    } catch {
      // Ignore
    } finally {
      setDlqLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (user) {
      fetchKeysAndQuota();
      fetchUserFiles();
      fetchDlqEntries();
    }
  }, [user, fetchKeysAndQuota, fetchUserFiles, fetchDlqEntries]);

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
      let expiresAt: number | undefined;
      const now = Date.now();
      if (keyExpiry === '30d') expiresAt = now + 30 * 86400 * 1000;
      else if (keyExpiry === '60d') expiresAt = now + 60 * 86400 * 1000;
      else if (keyExpiry === '90d') expiresAt = now + 90 * 86400 * 1000;
      else if (keyExpiry === '1y') expiresAt = now + 365 * 86400 * 1000;

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName || 'Production API Key',
          scopes: selectedScopes.length > 0 ? selectedScopes : ['*'],
          expiresAt,
        }),
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

  const handleReplayWebhook = async (id: string) => {
    setReplayingDlqId(id);
    setDlqFeedback(null);
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}/replay`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDlqFeedback(`Webhook replay succeeded! (HTTP ${data.statusCode})`);
      } else {
        setDlqFeedback(`Webhook replay failed: ${data.message || data.error || 'Delivery failed'}`);
      }
      await fetchDlqEntries();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network failure';
      setDlqFeedback(`Replay request failed: ${msg}`);
    } finally {
      setReplayingDlqId(null);
    }
  };

  const handleDeleteDlq = async (id: string) => {
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setDlqEntries((prev) => prev.filter((e) => e.id !== id));
      }
    } catch {
      // Ignore
    }
  };

  const handleClearDlq = async () => {
    try {
      const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' });
      if (res.ok) {
        setDlqEntries([]);
        setDlqFeedback('Dead letter queue cleared.');
      }
    } catch {
      // Ignore
    }
  };

  const handleRevokeKey = async (id: string) => {
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setRevokingKeyId(null);
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
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const renderKeyAction = (key: ApiKey) => {
    if (key.status !== 'active') {
      return <span className="text-xs text-ink-muted">Revoked</span>;
    }

    if (revokingKeyId === key.id) {
      return (
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => handleRevokeKey(key.id)}
            className="text-xs text-rose-600 font-bold hover:underline"
          >
            Confirm
          </button>
          <span className="text-ink-muted text-xs">/</span>
          <button
            type="button"
            onClick={() => setRevokingKeyId(null)}
            className="text-xs text-ink-secondary hover:underline"
          >
            Cancel
          </button>
        </div>
      );
    }

    return (
      <button
        type="button"
        onClick={() => setRevokingKeyId(key.id)}
        className="text-xs text-status-danger hover:underline font-medium"
      >
        Revoke
      </button>
    );
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
            onClick={() => setActiveTab('dlq')}
            className={`flex items-center gap-2 px-5 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'dlq'
                ? 'border-brand-700 text-brand-700 dark:text-brand-400 dark:border-brand-400'
                : 'border-transparent text-ink-secondary dark:text-dark-muted hover:text-ink-primary dark:hover:text-white'
            }`}
          >
            <Send className="w-4 h-4" />
            <span>Webhook DLQ</span>
            {dlqEntries.length > 0 && (
              <span className="ml-1.5 px-2 py-0.5 text-xs rounded-full bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 font-bold border border-rose-300 dark:border-rose-800">
                {dlqEntries.length}
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
                  <h3 className="text-sm font-bold mb-3">Create New API Key</h3>
                  <form onSubmit={handleGenerateKey} className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-1">
                        Key Name
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Production Backend Worker"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-sm focus:outline-none focus:ring-2 focus:ring-brand-700"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-1.5">
                          Granular Scopes (RBAC)
                        </label>
                        <div className="space-y-2">
                          {(
                            [
                              { id: 'convert:write', label: 'convert:write (Upload & Convert)' },
                              { id: 'convert:read', label: 'convert:read (Job Status & Polling)' },
                              { id: 'storage:download', label: 'storage:download (Output Artifacts)' },
                            ] as const
                          ).map((scopeItem) => (
                            <label key={scopeItem.id} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={selectedScopes.includes(scopeItem.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedScopes((prev) => [...prev, scopeItem.id]);
                                  } else {
                                    setSelectedScopes((prev) => prev.filter((s) => s !== scopeItem.id));
                                  }
                                }}
                                className="rounded text-brand-700 focus:ring-brand-700"
                              />
                              <span className="font-mono">{scopeItem.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-1.5">
                          Key Expiration
                        </label>
                        <select
                          value={keyExpiry}
                          onChange={(e) => setKeyExpiry(e.target.value as any)}
                          className="w-full px-3 py-2 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-xs focus:outline-none focus:ring-2 focus:ring-brand-700"
                        >
                          <option value="30d">30 Days</option>
                          <option value="60d">60 Days</option>
                          <option value="90d">90 Days</option>
                          <option value="1y">1 Year</option>
                          <option value="never">Never (No Expiration)</option>
                        </select>
                        <p className="text-[11px] text-ink-muted dark:text-dark-muted mt-2">
                          A <code>key.expiring_soon</code> event is dispatched 7 days prior to expiration.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="submit"
                        disabled={isGeneratingKey}
                        className="px-5 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm flex items-center gap-2 disabled:opacity-60"
                      >
                        {isGeneratingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                        <span>Create API Key</span>
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
                        <th className="pb-3 font-semibold">Name & Scopes</th>
                        <th className="pb-3 font-semibold">Key Prefix</th>
                        <th className="pb-3 font-semibold">Created</th>
                        <th className="pb-3 font-semibold">Expires</th>
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
                            <td className="py-4">
                              <div className="font-semibold text-ink-primary dark:text-white">
                                {key.name}
                              </div>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {key.scopes && key.scopes.length > 0 ? (
                                  key.scopes.map((s) => (
                                    <span
                                      key={s}
                                      className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted border border-neutral-border dark:border-dark-border"
                                    >
                                      {s}
                                    </span>
                                  ))
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted border border-neutral-border dark:border-dark-border">
                                    all scopes (*)
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-4 font-mono text-xs text-ink-secondary dark:text-dark-muted">
                              {key.prefix}
                            </td>
                            <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                              {new Date(key.createdAt).toLocaleDateString()}
                            </td>
                            <td className="py-4 text-xs">
                              {key.expiresAt ? (
                                Date.now() > key.expiresAt ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border border-rose-300 dark:border-rose-800">
                                    Expired
                                  </span>
                                ) : key.expiresAt - Date.now() <= 7 * 86400 * 1000 ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-300 dark:border-amber-800">
                                    Expiring in {Math.ceil((key.expiresAt - Date.now()) / (86400 * 1000))}d
                                  </span>
                                ) : (
                                  <span className="text-ink-secondary dark:text-dark-muted">
                                    {new Date(key.expiresAt).toLocaleDateString()}
                                  </span>
                                )
                              ) : (
                                <span className="text-ink-muted dark:text-dark-muted">Never</span>
                              )}
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
                              {renderKeyAction(key)}
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
            <IntegrationGuide sampleKeyDisplay={sampleKeyDisplay} copyToClipboard={copyToClipboard} />
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
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold shadow-sm"
                >
                  <span>Start Converting Files</span>
                </Link>
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

        {/* Tab 3: Webhook Dead Letter Queue (DLQ) */}
        {activeTab === 'dlq' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl p-6 sm:p-8 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold">Webhook Dead Letter Queue (DLQ)</h2>
                    {dlqEntries.length > 0 && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-300 dark:border-rose-800">
                        {dlqEntries.length} Failed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1">
                    Failed webhook notifications preserved after 3 exhausted exponential backoff attempts. Inspect payload data and trigger 1-click manual replays.
                  </p>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={fetchDlqEntries}
                    disabled={dlqLoading}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-neutral-border dark:border-dark-border text-xs font-medium hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${dlqLoading ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                  {dlqEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearDlq}
                      className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-rose-200 dark:border-rose-900/50 text-rose-700 dark:text-rose-400 text-xs font-medium hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear DLQ</span>
                    </button>
                  )}
                </div>
              </div>

              {dlqFeedback && (
                <div className="mb-4 p-3 rounded-xl bg-brand-50 dark:bg-brand-950/30 border border-brand-200 dark:border-brand-800/40 text-xs text-brand-800 dark:text-brand-300 flex items-center justify-between">
                  <span>{dlqFeedback}</span>
                  <button type="button" onClick={() => setDlqFeedback(null)} className="font-bold ml-2">✕</button>
                </div>
              )}

              {dlqEntries.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed border-neutral-border dark:border-dark-border rounded-2xl">
                  <Inbox className="w-12 h-12 text-ink-muted dark:text-dark-muted mx-auto mb-3" />
                  <p className="text-base font-semibold">Dead Letter Queue is Empty</p>
                  <p className="text-xs text-ink-muted dark:text-dark-muted mt-1 max-w-sm mx-auto">
                    All webhook deliveries have succeeded or no dispatches have failed.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
                        <th className="pb-3 font-semibold">Event</th>
                        <th className="pb-3 font-semibold">Target URL</th>
                        <th className="pb-3 font-semibold">Status / Code</th>
                        <th className="pb-3 font-semibold">Failed At</th>
                        <th className="pb-3 font-semibold">Retries</th>
                        <th className="pb-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
                      {dlqEntries.map((entry) => {
                        const isReplayed = entry.status === 'replayed';
                        return (
                          <tr key={entry.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                            <td className="py-4">
                              <span className="font-mono text-xs font-semibold text-brand-700 dark:text-brand-400">
                                {entry.event}
                              </span>
                            </td>
                            <td className="py-4 font-mono text-xs max-w-xs truncate text-ink-secondary dark:text-dark-muted" title={entry.targetUrl}>
                              {entry.targetUrl}
                            </td>
                            <td className="py-4">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                                  isReplayed
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                                    : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20'
                                }`}
                              >
                                {isReplayed ? 'REPLAYED' : `HTTP ${entry.finalStatusCode ?? 'ERR'}`}
                              </span>
                            </td>
                            <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                              {new Date(entry.failedAt).toLocaleString()}
                            </td>
                            <td className="py-4 text-xs text-ink-secondary dark:text-dark-muted">
                              {entry.retryCount} attempts
                            </td>
                            <td className="py-4 text-right">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setInspectingDlq(entry)}
                                  className="p-1.5 rounded-lg border border-neutral-border dark:border-dark-border hover:bg-neutral-subtle dark:hover:bg-dark-elevated text-xs font-medium text-ink-secondary hover:text-ink-primary"
                                  title="Inspect Payload"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleReplayWebhook(entry.id)}
                                  disabled={replayingDlqId === entry.id}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold shadow-sm transition-all disabled:opacity-60"
                                >
                                  {replayingDlqId === entry.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Play className="w-3 h-3" />
                                  )}
                                  <span>Replay</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteDlq(entry.id)}
                                  className="p-1.5 rounded-lg border border-neutral-border dark:border-dark-border hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-600 text-xs"
                                  title="Delete"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* DLQ Payload Inspection Modal */}
            {inspectingDlq && (
              <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-2xl max-w-2xl w-full p-6 shadow-xl space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold">Inspect Webhook Payload</h3>
                      <p className="text-xs text-ink-secondary dark:text-dark-muted font-mono mt-0.5">
                        {inspectingDlq.id} • {inspectingDlq.event}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setInspectingDlq(null)}
                      className="text-ink-secondary hover:text-ink-primary font-bold text-lg p-1"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div>
                      <span className="font-semibold text-ink-muted">Target URL:</span>
                      <p className="font-mono bg-neutral-subtle dark:bg-dark-elevated p-2 rounded-lg mt-1 break-all">
                        {inspectingDlq.targetUrl}
                      </p>
                    </div>
                    {inspectingDlq.errorMessage && (
                      <div>
                        <span className="font-semibold text-rose-600">Failure Error:</span>
                        <p className="font-mono text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/20 p-2 rounded-lg mt-1">
                          {inspectingDlq.errorMessage}
                        </p>
                      </div>
                    )}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-ink-muted">Payload JSON:</span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(JSON.stringify(inspectingDlq.payload, null, 2))}
                          className="flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copy Payload</span>
                        </button>
                      </div>
                      <pre className="p-3 rounded-xl bg-ink-primary dark:bg-dark-scaffold text-neutral-subtle font-mono text-xs overflow-x-auto max-h-64 border border-dark-border">
                        {JSON.stringify(inspectingDlq.payload, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        handleReplayWebhook(inspectingDlq.id);
                        setInspectingDlq(null);
                      }}
                      className="px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-xs flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Replay Now</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectingDlq(null)}
                      className="px-4 py-2 rounded-xl border border-neutral-border dark:border-dark-border text-xs font-semibold"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 4: Plans & Quotas */}
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
