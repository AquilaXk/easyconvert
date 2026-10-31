import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@/lib/auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage, WebhookDlqEntry } from '@/lib/api-keys/types';
import type { ApiKeysPanelActions, ApiKeysPanelState } from './ApiKeysPanel';
import {
  resolveExpiryTimestamp,
  type DashboardTab,
  type FileWithRemaining,
  type KeyExpiryOption,
} from './dashboard-types';

function useApiKeysController(enabled: boolean) {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState<QuotaUsage | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([
    'convert:write',
    'convert:read',
    'storage:download',
  ]);
  const [keyExpiry, setKeyExpiry] = useState<KeyExpiryOption>('30d');

  const fetchKeysAndQuota = useCallback(async () => {
    try {
      const [keysRes, quotaRes] = await Promise.all([fetch('/api/keys'), fetch('/api/keys/usage')]);
      if (keysRes.ok) {
        const keysData = await keysRes.json();
        if (keysData.success) setApiKeys(keysData.keys);
      }
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        if (quotaData.success) setQuota(quotaData.usage);
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      fetchKeysAndQuota();
    }
  }, [enabled, fetchKeysAndQuota]);

  const copyToClipboard = useCallback((text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  }, []);

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGeneratingKey(true);
    try {
      const expiresAt = resolveExpiryTimestamp(keyExpiry, Date.now());
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
        setShowGenerateForm(false);
        await fetchKeysAndQuota();
      }
    } catch {
      return;
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setRevokingKeyId(null);
      await fetchKeysAndQuota();
    }
  };

  const handleToggleScope = (scope: ApiKeyScope, checked: boolean) => {
    setSelectedScopes((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)));
  };

  const state: ApiKeysPanelState = {
    apiKeys,
    quota,
    newKeyName,
    generatedSecret,
    isGeneratingKey,
    showGenerateForm,
    copiedKey,
    revokingKeyId,
    selectedScopes,
    keyExpiry,
  };

  const actions: ApiKeysPanelActions = {
    onOpenGenerateForm: () => setShowGenerateForm(true),
    onCloseGenerateForm: () => setShowGenerateForm(false),
    onDismissGeneratedSecret: () => setGeneratedSecret(null),
    onNameChange: setNewKeyName,
    onToggleScope: handleToggleScope,
    onExpiryChange: setKeyExpiry,
    onGenerateKey: handleGenerateKey,
    onRequestRevoke: setRevokingKeyId,
    onConfirmRevoke: handleRevokeKey,
    onCopy: copyToClipboard,
  };

  return { state, actions, copyToClipboard };
}

function useFilesAndDlqController(enabled: boolean) {
  const [userFiles, setUserFiles] = useState<FileWithRemaining[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [dlqEntries, setDlqEntries] = useState<WebhookDlqEntry[]>([]);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [inspectingDlq, setInspectingDlq] = useState<WebhookDlqEntry | null>(null);
  const [replayingDlqId, setReplayingDlqId] = useState<string | null>(null);
  const [dlqFeedback, setDlqFeedback] = useState<string | null>(null);

  const fetchUserFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await fetch('/api/account/files');
      if (res.ok) {
        const data = await res.json();
        if (data.success) setUserFiles(data.files);
      }
    } catch {
      return;
    } finally {
      setFilesLoading(false);
    }
  }, []);

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
      return;
    } finally {
      setDlqLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      fetchUserFiles();
      fetchDlqEntries();
    }
  }, [enabled, fetchUserFiles, fetchDlqEntries]);

  useEffect(() => {
    const timer = setInterval(() => {
      setUserFiles((prev) =>
        prev
          .map((file) => ({
            ...file,
            remainingSeconds: Math.max(0, file.remainingSeconds - 1),
          }))
          .filter((file) => file.remainingSeconds > 0)
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleDeleteFile = async (id: string) => {
    const res = await fetch(`/api/account/files/${id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setUserFiles((prev) => prev.filter((file) => file.id !== id));
    }
  };

  const handleReplayWebhook = async (id: string) => {
    setReplayingDlqId(id);
    setDlqFeedback(null);
    try {
      const res = await fetch(`/api/webhooks/dlq/${id}/replay`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDlqFeedback(`Webhook replay succeeded (HTTP ${data.statusCode}).`);
      } else {
        setDlqFeedback(`Webhook replay failed (${data.message || data.error || 'Delivery failed'}).`);
      }
      await fetchDlqEntries();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network failure';
      setDlqFeedback(`Replay request failed (${msg}).`);
    } finally {
      setReplayingDlqId(null);
    }
  };

  const handleDeleteDlq = async (id: string) => {
    const res = await fetch(`/api/webhooks/dlq/${id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setDlqEntries((prev) => prev.filter((entry) => entry.id !== id));
    }
  };

  const handleClearDlq = async () => {
    const res = await fetch('/api/webhooks/dlq', { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setDlqEntries([]);
      setDlqFeedback('Dead letter queue cleared.');
    }
  };

  return {
    userFiles,
    filesLoading,
    fetchUserFiles,
    handleDeleteFile,
    dlqEntries,
    dlqLoading,
    inspectingDlq,
    setInspectingDlq,
    replayingDlqId,
    dlqFeedback,
    setDlqFeedback,
    fetchDlqEntries,
    handleReplayWebhook,
    handleDeleteDlq,
    handleClearDlq,
  };
}

export function useDashboardController() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('api');
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/auth');
    router.refresh();
  };

  const keys = useApiKeysController(Boolean(user));
  const filesAndDlq = useFilesAndDlqController(Boolean(user));

  return {
    user,
    loading,
    activeTab,
    setActiveTab,
    handleLogout,
    keys,
    filesAndDlq,
  };
}
