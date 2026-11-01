import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import type { User } from '@/lib/auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from '@/lib/api-keys/types';
import type { ApiKeysPanelActions, ApiKeysPanelState } from './ApiKeysPanel';
import {
  resolveExpiryTimestamp,
  type DashboardTab,
  type KeyExpiryOption,
} from './dashboard-types';
import { useFilesAndDlqController } from './useDashboardResources';
import { applySessionChange } from '@/lib/viewer-plan';
import { useServerErrorMessage } from '../i18n/problems';

/** The body of a key creation, or why there is none; `defaultName` names a key the form left unnamed. */
export function buildKeyCreationRequest(
  newKeyName: string,
  selectedScopes: ApiKeyScope[],
  keyExpiry: KeyExpiryOption,
  nowMs: number,
  defaultName: string
):
  | { ok: true; body: { name: string; scopes: ApiKeyScope[]; expiresAt?: number } }
  | { ok: false; error: 'noScopes' } {
  if (selectedScopes.length === 0) return { ok: false, error: 'noScopes' };
  return {
    ok: true,
    body: {
      name: newKeyName || defaultName,
      scopes: selectedScopes,
      expiresAt: resolveExpiryTimestamp(keyExpiry, nowMs),
    },
  };
}

function useClipboardCopyStatus() {
  const [copiedKey, setCopiedKey] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const writeSecret = async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(true);
        if (copyTimerRef.current !== null) {
          clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = setTimeout(() => {
          setCopiedKey(false);
          copyTimerRef.current = null;
        }, 2000);
      } catch {
        setCopiedKey(false);
      }
    };
    void writeSecret();
  }, []);

  return { copiedKey, copyToClipboard };
}

function useApiKeysController(
  enabled: boolean,
  onReportError: (message: string | null) => void
) {
  const t = useTranslations('dashboard.errors');
  const tKeys = useTranslations('dashboard.keys');
  const extractApiError = useServerErrorMessage();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState<QuotaUsage | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([
    'convert:write',
    'convert:read',
    'storage:download',
  ]);
  const [keyExpiry, setKeyExpiry] = useState<KeyExpiryOption>('30d');
  const { copiedKey, copyToClipboard } = useClipboardCopyStatus();

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
        onReportError(extractApiError(errBody, t('loadKeys', { status: keysRes.status })));
      }
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        if (quotaData.success) setQuota(quotaData.usage);
      }
    } catch {
      onReportError(t('loadKeysNetwork'));
    }
  }, [onReportError, extractApiError, t]);

  useEffect(() => {
    if (enabled) {
      void fetchKeysAndQuota();
    }
  }, [enabled, fetchKeysAndQuota]);

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const request = buildKeyCreationRequest(newKeyName, selectedScopes, keyExpiry, Date.now(), tKeys('defaultName'));
    if (!request.ok) {
      onReportError(t(request.error));
      return;
    }
    setIsGeneratingKey(true);
    onReportError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
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
      onReportError(extractApiError(data, t('createKey', { status: res.status })));
    } catch {
      onReportError(t('createKeyNetwork'));
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
        onReportError(extractApiError(data, t('revokeKey', { status: res.status })));
        return;
      }
      setRevokingKeyId(null);
      await fetchKeysAndQuota();
    } catch {
      onReportError(t('revokeKeyNetwork'));
    }
  };

  const handleToggleScope = (scope: ApiKeyScope, checked: boolean) => {
    setSelectedScopes((prev) => {
      if (checked) return prev.includes(scope) ? prev : [...prev, scope];
      return prev.filter((s) => s !== scope);
    });
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
  const t = useTranslations('dashboard.errors');
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
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      // A sign-out the server refused leaves the session, so the header keeps the account until the page is read again.
      if (res.ok) applySessionChange(null);
    } catch {
      setActionError(t('signOutNetwork'));
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
