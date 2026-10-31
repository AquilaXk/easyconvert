import React from 'react';
import type { Metadata } from 'next';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import StatusDashboard from '@/components/StatusDashboard';

export const metadata: Metadata = {
  title: 'Browser Edge Engine Status | EasyConvert',
  description:
    'Live operational status, browser engine diagnostics, and capability probes for EasyConvert WebAssembly, WebCodecs, and OPFS conversion pipelines.',
};

export default function StatusPage() {
  return (
    <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-brand-950 dark:text-white">
            System Operational Status
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
            Real-time capability checks, latency probes, and component status for in-browser WebAssembly, WebCodecs, and OPFS conversion pipelines.
          </p>
        </div>

        <StatusDashboard />
      </main>

      <Footer />
    </div>
  );
}
