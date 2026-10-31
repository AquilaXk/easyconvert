'use client';

import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ApiKeysPanel } from '@/components/dashboard/ApiKeysPanel';
import { JobsHistoryPanel } from '@/components/dashboard/JobsHistoryPanel';
import { WebhooksPanel } from '@/components/dashboard/WebhooksPanel';
import { AccountQuotaPanel } from '@/components/dashboard/AccountQuotaPanel';
import { useDashboardController } from '@/components/dashboard/useDashboardController';

export default function DashboardPage() {
  const {
    user,
    loading,
    activeTab,
    setActiveTab,
    actionError,
    clearActionError,
    handleLogout,
    keys,
    filesAndDlq,
  } = useDashboardController();

  return (
    <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold flex flex-col text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <main
        id="main-content"
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12"
      >
        {loading || !user ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3">
            <h1 className="text-xl font-bold text-brand-950 dark:text-white">
              Developer Dashboard
            </h1>
            <output
              aria-live="polite"
              className="flex flex-col items-center justify-center gap-3"
            >
              <Loader2
                className="w-7 h-7 animate-spin text-brand-700 dark:text-brand-400"
                aria-hidden="true"
              />
              <span className="text-sm text-ink-secondary dark:text-dark-muted">
                Loading account session...
              </span>
            </output>
          </div>
        ) : (
          <>
            <DashboardHeader
              user={user}
              activeTab={activeTab}
              filesCount={filesAndDlq.userFiles.length}
              dlqCount={filesAndDlq.dlqEntries.length}
              onSelectTab={(tab) => {
                clearActionError();
                filesAndDlq.setInspectingDlq(null);
                setActiveTab(tab);
              }}
              onLogout={() => {
                void handleLogout();
              }}
            />

            {actionError && (
              <div
                role="alert"
                className="mb-6 pl-4 pr-2 py-2.5 rounded-xl bg-status-dangerSoft dark:bg-rose-950/30 border border-status-danger/30 dark:border-rose-800/50 text-status-danger dark:text-rose-300 text-sm flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                  <span className="break-words">{actionError}</span>
                </div>
                <button
                  type="button"
                  onClick={clearActionError}
                  aria-label="Dismiss dashboard error"
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md hover:bg-rose-100 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {activeTab === 'api' && <ApiKeysPanel state={keys.state} actions={keys.actions} />}

            {activeTab === 'files' && (
              <JobsHistoryPanel
                files={filesAndDlq.userFiles}
                loading={filesAndDlq.filesLoading}
                onRefresh={() => {
                  void filesAndDlq.fetchUserFiles();
                }}
                onDeleteFile={(id) => {
                  void filesAndDlq.handleDeleteFile(id);
                }}
              />
            )}

            {activeTab === 'dlq' && (
              <WebhooksPanel
                entries={filesAndDlq.dlqEntries}
                loading={filesAndDlq.dlqLoading}
                replayingId={filesAndDlq.replayingDlqId}
                feedback={filesAndDlq.dlqFeedback}
                inspectingEntry={filesAndDlq.inspectingDlq}
                onRefresh={() => {
                  void filesAndDlq.fetchDlqEntries();
                }}
                onClearAll={() => {
                  void filesAndDlq.handleClearDlq();
                }}
                onDismissFeedback={() => filesAndDlq.setDlqFeedback(null)}
                onInspect={filesAndDlq.setInspectingDlq}
                onReplay={(id) => {
                  void filesAndDlq.handleReplayWebhook(id);
                }}
                onDelete={(id) => {
                  void filesAndDlq.handleDeleteDlq(id);
                }}
                onCopy={keys.copyToClipboard}
              />
            )}

            {activeTab === 'usage' && (
              <AccountQuotaPanel
                user={user}
                quota={keys.state.quota}
                apiKeys={keys.state.apiKeys}
              />
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
