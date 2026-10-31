'use client';

import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { Loader2 } from 'lucide-react';
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
    handleLogout,
    keys,
    filesAndDlq,
  } = useDashboardController();

  return (
    <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold flex flex-col text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <main id="main-content" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        {loading || !user ? (
          <div role="status" className="py-20 flex flex-col items-center justify-center gap-3">
            <h1 className="text-xl font-bold text-brand-950 dark:text-white">Developer Dashboard</h1>
            <Loader2 className="w-7 h-7 animate-spin text-brand-700 dark:text-brand-400" aria-hidden="true" />
            <p className="text-sm text-ink-secondary dark:text-dark-muted">Loading account session...</p>
          </div>
        ) : (
          <>
            <DashboardHeader
              user={user}
              activeTab={activeTab}
              filesCount={filesAndDlq.userFiles.length}
              dlqCount={filesAndDlq.dlqEntries.length}
              onSelectTab={setActiveTab}
              onLogout={handleLogout}
            />

            {activeTab === 'api' && (
              <ApiKeysPanel state={keys.state} actions={keys.actions} />
            )}

            {activeTab === 'files' && (
              <JobsHistoryPanel
                files={filesAndDlq.userFiles}
                loading={filesAndDlq.filesLoading}
                onRefresh={filesAndDlq.fetchUserFiles}
                onDeleteFile={filesAndDlq.handleDeleteFile}
              />
            )}

            {activeTab === 'dlq' && (
              <WebhooksPanel
                entries={filesAndDlq.dlqEntries}
                loading={filesAndDlq.dlqLoading}
                replayingId={filesAndDlq.replayingDlqId}
                feedback={filesAndDlq.dlqFeedback}
                inspectingEntry={filesAndDlq.inspectingDlq}
                onRefresh={filesAndDlq.fetchDlqEntries}
                onClearAll={filesAndDlq.handleClearDlq}
                onDismissFeedback={() => filesAndDlq.setDlqFeedback(null)}
                onInspect={filesAndDlq.setInspectingDlq}
                onReplay={filesAndDlq.handleReplayWebhook}
                onDelete={filesAndDlq.handleDeleteDlq}
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
