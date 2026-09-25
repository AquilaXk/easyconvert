'use client';

import React from 'react';
import { ShieldCheck, Cpu, SlidersHorizontal, Terminal } from 'lucide-react';

export default function Features() {
  const features = [
    {
      icon: <Cpu className="w-6 h-6 text-brand-700 dark:text-brand-400" />,
      title: '200+ Formats Supported',
      description:
        'Seamlessly convert across images, documents, structured tables, and archives. No software downloads required — everything runs in modern high-speed runtime pipelines.',
    },
    {
      icon: <ShieldCheck className="w-6 h-6 text-brand-700 dark:text-brand-400" />,
      title: 'Privacy & Ephemeral Security',
      description:
        'Your security is paramount. Uploads are strictly processed in isolated ephemeral instances and erased immediately upon completion. We never inspect or store your data.',
    },
    {
      icon: <SlidersHorizontal className="w-6 h-6 text-brand-700 dark:text-brand-400" />,
      title: 'High-Quality & Custom Parameters',
      description:
        'Adjust image compression quality, resize dimensions, customize PDF orientation, set CSV delimiters, and choose archive compression levels for optimal fidelity.',
    },
    {
      icon: <Terminal className="w-6 h-6 text-brand-700 dark:text-brand-400" />,
      title: 'Developer REST API',
      description:
        'Integrate file conversions effortlessly into your stack. Use our standard multipart endpoints with full format matrix discovery and automated job bundling.',
    },
  ];

  return (
    <section className="py-16 md:py-24 border-t border-neutral-border dark:border-dark-border bg-neutral-scaffold/50 dark:bg-dark-scaffold/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-4">
            Engineered for Precision & Reliability
          </h2>
          <p className="text-sm sm:text-base text-ink-secondary dark:text-dark-muted">
            EasyConvert combines industry-standard processing kernels with an intuitive lavender-infused user
            interface for seamless transformations.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, idx) => (
            <div
              key={idx}
              className="p-6 rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm hover:shadow-md hover:border-brand-300 dark:hover:border-brand-800 transition-all group"
            >
              <div className="p-3 rounded-xl bg-brand-50 dark:bg-dark-elevated w-fit mb-4 group-hover:scale-105 transition-transform">
                {feature.icon}
              </div>
              <h3 className="text-base font-bold text-brand-950 dark:text-dark-text mb-2">{feature.title}</h3>
              <p className="text-xs text-ink-secondary dark:text-dark-muted leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
