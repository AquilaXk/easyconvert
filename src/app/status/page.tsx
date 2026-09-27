import React from 'react';
import type { Metadata } from 'next';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import StatusDashboard from '@/components/StatusDashboard';

export const metadata: Metadata = {
  title: 'Browser Edge Engine Real-Time Status — EasyConvert',
  description:
    'Live real-time operational status, latency metrics, and 90-day uptime monitoring for EasyConvert in-browser conversion engines and zero-retention sandbox.',
};

export default function StatusPage() {
  return (
    <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        {/* Page Title & Breadcrumb Header */}
        <div className="mb-8 text-center sm:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-300 dark:border-white/10 mb-3">
            <span>Edge Infrastructure Telemetry</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-brand-950 dark:text-white">
            System Operational Status
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
            Real-time health, latency benchmarks, and component status for all in-browser WebAssembly, WebCodecs, and OPFS conversion pipelines.
          </p>
        </div>

        {/* Real-time Status Dashboard */}
        <StatusDashboard />
      </main>

      <Footer />
    </div>
  );
}
