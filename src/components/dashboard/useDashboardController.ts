import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@/lib/auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from '@/lib/api-keys/types';
import type { ApiKeysPanelActions, ApiKeysPanelState } from './ApiKeysPanel';
import {
  extractApiError,
  resolveExpiryTimestamp,
  type DashboardTab,
  type KeyExpiryOption,
} from './dashboard-types';
import { useFilesAndDlqController } from './useDashboardResources';

function useApiKeysController(
  enabled: boolean,
  onReportError: (message: string | null) => void
) {
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
      const [keysRes, quotaRes] = await Promise.all([
        fetch('/api/keys'),
        fetch('/api/keys/usage'),
      ]);
      if (keysRes.ok) {
        const keysData = await keysRes.json();
        if (keysData.success) setApiKeys(keysData.keys);
      } else {
        const errBody: unknown = await keysRes.json().catch(() => null);
        onReportError(extractApiError(errBody, `Failed to load API keys (HTTP ${keysRes.status}).`));
      }
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        if (quotaData.success) setQuota(quotaData.usage);
      }
    } catch {
      onReportError('Network error while loading API keys.');
    }
  }, [onReportError]);

  useEffect(() => {
    if (enabled) {
      void fetchKeysAndQuota();
    }
  }, [enabled, fetchKeysAndQuota]);

  const copyToClipboard = useCallback((text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  }, []);

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGeneratingKey(true);
    onReportError(null);
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
      const data: unknown = await res.json().catch(() => null);
      if (
        res.ok &&
        data &&
        typeof data === 'object' &&
        'success' in data &&
        data.success &&
        'secretKey' in data &&
        typeof data.secretKey === 'string'
      ) {
        setGeneratedSecret(data.secretKey);
        setNewKeyName('');
        setShowGenerateForm(false);
        await fetchKeysAndQuota();
        return;
      }
      onReportError(extractApiError(data, `Failed to create API key (HTTP ${res.status}).`));
    } catch {
      onReportError('Network error while creating API key.');
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    onReportError(null);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        onReportError(extractApiError(data, `Failed to revoke API key (HTTP ${res.status}).`));
        return;
      }
      setRevokingKeyId(null);
      await fetchKeysAndQuota();
    } catch {
      onReportError('Network error while revoking API key.');
    }
  };

  const handleToggleScope = (scope: ApiKeyScope, checked: boolean) => {
    setSelectedScopes((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)));
  };

  const state: ApiKeysPanelState = {
    apiKeys, quota, newKeyName, generatedSecret, isGeneratingKey,
    showGenerateForm, copiedKey, revokingKeyId, selectedScopes, keyExpiry,
  };

  const actions: ApiKeysPanelActions = {
    onOpenGenerateForm: () => setShowGenerateForm(true),
    onCloseGenerateForm: () => setShowGenerateForm(false),
    onDismissGeneratedSecret: () => setGeneratedSecret(null),
    onNameChange: setNewKeyName,
    onToggleScope: handleToggleScope,
    onExpiryChange: setKeyExpiry,
    onGenerateKey: (event) => { void handleGenerateKey(event); },
    onRequestRevoke: setRevokingKeyId,
    onConfirmRevoke: (id) => { void handleRevokeKey(id); },
    onCopy: copyToClipboard,
  };

  return { state, actions, copyToClipboard };
}

export function useDashboardController() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('api');
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const reportError = useCallback((message: string | null) => setActionError(message), []);
  const clearActionError = useCallback(() => setActionError(null), []);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        router.push('/auth');
        return;
      }
      const data = await res.json();
      if (data.success && data.user) setUser(data.user);
      else router.push('/auth');
    } catch {
      router.push('/auth');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      setActionError('Network error while signing out.');
    }
    router.push('/auth');
    router.refresh();
  };

  const keys = useApiKeysController(Boolean(user), reportError);
  const filesAndDlq = useFilesAndDlqController(Boolean(user), reportError);

  return {
    user, loading, activeTab, setActiveTab, actionError, clearActionError,
    handleLogout, keys, filesAndDlq,
  };
}
