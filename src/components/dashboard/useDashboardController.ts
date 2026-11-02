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
import { warnBrowserFailure } from '@/lib/browser-failure';
import { applySessionChange } from '@/lib/viewer-plan';
import { useDashboardErrorWording } from '../i18n/error-wording';
import { useRecordDelete } from './useRecordDelete';

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

export function useApiKeysController(
  enabled: boolean,
  onReportError: (error: string | null) => void
) {
  const t = useTranslations('dashboard.errors');
  const tKeys = useTranslations('dashboard.keys');
  const problemWording = useDashboardErrorWording();
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
        onReportError(problemWording(errBody, keysRes.status, t('loadKeys')));
      }
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        if (quotaData.success) setQuota(quotaData.usage);
      }
    } catch (error) {
      warnBrowserFailure('Reading the API keys failed', error);
      onReportError(t('loadKeysNetwork'));
    }
  }, [onReportError, problemWording, t]);

  // The read runs when the dashboard is enabled, not again when the zone switch after hydration renews the wording.
  const fetchKeysAndQuotaRef = useRef(fetchKeysAndQuota);
  fetchKeysAndQuotaRef.current = fetchKeysAndQuota;
  useEffect(() => {
    if (enabled) void fetchKeysAndQuotaRef.current();
  }, [enabled]);

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
      onReportError(problemWording(data, res.status, t('createKey')));
    } catch (error) {
      warnBrowserFailure('Creating an API key failed', error);
      onReportError(t('createKeyNetwork'));
    } finally {
      setIsGeneratingKey(false);
    }
  };

  // A revoked key stays in the list as revoked; one the server no longer knows leaves it. Either way only its own
  // confirmation closes, so the confirmation of another key opened meanwhile stays open.
  const keyRevoke = useRecordDelete({
    url: (id) => `/api/keys/${id}`,
    goneSentence: t('revokeKeyGone'),
    failedSentence: t('revokeKey'),
    networkSentence: t('revokeKeyNetwork'),
    warnNetworkFailure: (error) => warnBrowserFailure('Revoking an API key failed', error),
    onReportError,
    onRemoved: (id, wasGone) => {
      if (wasGone) setApiKeys((prev) => prev.filter((key) => key.id !== id));
      setRevokingKeyId((current) => (current === id ? null : current));
    },
    refetch: fetchKeysAndQuota,
  });

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
    onConfirmRevoke: (id) => { void keyRevoke.remove(id); },
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

  const reportError = useCallback((error: string | null) => setActionError(error), []);
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
    } catch (error) {
      warnBrowserFailure('Signing out failed', error);
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
