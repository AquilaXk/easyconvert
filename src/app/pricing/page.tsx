'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  Check,
  ChevronDown,
  X,
  Calculator,
  ArrowRight,
  Shield,
  HelpCircle,
  Zap,
} from 'lucide-react';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { TierData, TIERS, calculateBaseCredits } from '@/lib/pricing';

export default function PricingPage() {
  const [sliderIndex, setSliderIndex] = useState(1); // Default to 1,000 credits
  const [activeTab, setActiveTab] = useState<'packages' | 'subscriptions'>('packages');
  const [openFaq, setOpenFaq] = useState<number | null>(0); // First FAQ open by default
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);

  // Calculator State
  const [calcOperation, setCalcOperation] = useState('convert');
  const [calcInputFmt, setCalcInputFmt] = useState('pdf');
  const [calcOutputFmt, setCalcOutputFmt] = useState('docx');

  const currentTier = TIERS[sliderIndex];
  const { credits, packagePrice, subPrice } = currentTier;

  const pkgCostPerCredit = (packagePrice / credits).toFixed(3);
  const subCostPerCredit = (subPrice / credits).toFixed(3);

  const baseCreditsCalculated = calculateBaseCredits(calcOperation, calcInputFmt, calcOutputFmt);

  return (
    <div className="flex flex-col min-h-screen bg-[#141414] text-white">
      <Header />

      <main className="flex-1">
        {/* Top Hero Section */}
        <section className="relative overflow-hidden pt-12 pb-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
          {/* Subtle lavender gradient accent */}
          <div
            aria-hidden="true"
            className="absolute top-0 right-1/4 w-96 h-96 bg-[#5C6BC0]/15 rounded-full blur-3xl pointer-events-none"
          />

          <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            {/* Left: Heading & Intro */}
            <div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white">
                Pricing
              </h1>
              <p className="mt-4 text-base sm:text-lg text-neutral-300 leading-relaxed max-w-xl">
                Pay only for what you need. Use the slider to choose the number of conversion credits
                you want, and see prices update instantly.
              </p>
            </div>

            {/* Right: Dynamic Volume Selector Card with Packages vs Subscriptions Tab */}
            <div className="bg-[#1e1e1e] border border-neutral-800 rounded-2xl p-6 sm:p-8 shadow-2xl relative">
              <div className="text-center">
                {/* Packages vs Subscriptions Toggle Tabs */}
                <div className="inline-flex p-1 bg-neutral-900 border border-neutral-800 rounded-xl mb-6">
                  <button
                    type="button"
                    onClick={() => setActiveTab('packages')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      activeTab === 'packages'
                        ? 'bg-[#5C6BC0] text-white shadow-md'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Packages (Pay As You Go)
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('subscriptions')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      activeTab === 'subscriptions'
                        ? 'bg-[#5C6BC0] text-white shadow-md'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Subscriptions (Save ~50%)
                  </button>
                </div>

                <span className="text-xs uppercase tracking-widest text-neutral-400 font-bold block mb-2">
                  Select Your Volume
                </span>
                <div className="flex items-baseline justify-center gap-2 mb-6">
                  <span className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight">
                    {credits.toLocaleString()}
                  </span>
                  <span className="text-neutral-400 font-medium text-lg">credits</span>
                </div>

                {/* Range Slider */}
                <div className="relative px-2">
                  <input
                    type="range"
                    min={0}
                    max={TIERS.length - 1}
                    step={1}
                    value={sliderIndex}
                    onChange={(e) => setSliderIndex(Number(e.target.value))}
                    className="w-full h-2.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-[#5C6BC0]"
                    aria-label="Volume slider"
                  />
                  <div className="flex justify-between text-xs text-neutral-400 font-medium mt-3">
                    <span>500</span>
                    <span>1,000,000</span>
                  </div>
                </div>

                {/* Dynamic Price Summary line */}
                <div className="mt-6 pt-5 border-t border-neutral-800/80 text-xs sm:text-sm text-neutral-300">
                  <span>Packages from </span>
                  <span className={`font-bold ${activeTab === 'packages' ? 'text-[#7986CB] underline decoration-2' : 'text-white'}`}>
                    US${packagePrice.toFixed(2)}
                  </span>
                  <span> · Subscriptions from </span>
                  <span className={`font-bold ${activeTab === 'subscriptions' ? 'text-[#7986CB] underline decoration-2' : 'text-white'}`}>
                    US${subPrice.toFixed(2)}/month
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4-Column Pricing Matrix Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-14">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* 1. Free Column */}
            <div className="bg-[#181818] border border-neutral-800 rounded-2xl p-6 sm:p-7 flex flex-col justify-between hover:border-neutral-700 transition-all">
              <div>
                <h3 className="text-xl font-bold text-white mb-2">Free</h3>
                <p className="text-xs text-neutral-400 min-h-[36px]">
                  For personal use, testing and hobby projects.
                </p>

                <div className="my-6">
                  <span className="text-3xl font-extrabold text-white">US$0</span>
                </div>

                <a
                  href="/register"
                  className="block text-center w-full py-2.5 px-4 rounded-lg border border-neutral-700 hover:border-neutral-500 text-white font-semibold text-sm transition-all"
                >
                  Sign Up
                </a>

                <div className="mt-8 space-y-4 pt-6 border-t border-neutral-800/80 text-xs">
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Conversion Credits</span>
                    <span className="font-semibold text-white">10 / day</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Cost per Credit</span>
                    <span className="font-semibold text-white">Free</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Credit Expiry</span>
                    <span className="font-semibold text-white">Daily reset</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 2. Package Column */}
            <div
              className={`bg-[#1e1e1e] border-2 rounded-2xl p-6 sm:p-7 flex flex-col justify-between transition-all relative ${
                activeTab === 'packages'
                  ? 'border-[#5C6BC0] shadow-xl shadow-[#5C6BC0]/15'
                  : 'border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-[#5C6BC0] text-white text-[10px] font-bold uppercase tracking-wider rounded-full shadow-md">
                One-Time Payment
              </div>
              <div>
                <h3 className="text-xl font-bold text-white mb-2">Package</h3>
                <p className="text-xs text-neutral-400 min-h-[36px]">
                  One-time payment. Credits never expire.
                </p>

                <div className="my-6">
                  <span className="text-3xl font-extrabold text-white">
                    US${packagePrice.toFixed(2)}
                  </span>
                </div>

                <a
                  href="/register"
                  className="block text-center w-full py-2.5 px-4 rounded-lg bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] text-white font-semibold text-sm shadow-md transition-all"
                >
                  Buy Now
                </a>

                <div className="mt-8 space-y-4 pt-6 border-t border-neutral-800/80 text-xs">
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Conversion Credits</span>
                    <span className="font-semibold text-white">{credits.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Cost per Credit</span>
                    <span className="font-semibold text-white">US${pkgCostPerCredit}</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Credit Expiry</span>
                    <span className="font-semibold text-white">Never</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Subscription Column */}
            <div
              className={`bg-[#1e1e1e] border-2 rounded-2xl p-6 sm:p-7 flex flex-col justify-between transition-all relative ${
                activeTab === 'subscriptions'
                  ? 'border-[#5C6BC0] shadow-xl shadow-[#5C6BC0]/15'
                  : 'border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-[#5C6BC0] text-white text-[10px] font-bold uppercase tracking-wider rounded-full shadow-md">
                Best Value
              </div>
              <div>
                <h3 className="text-xl font-bold text-white mb-2">Subscription</h3>
                <p className="text-xs text-neutral-400 min-h-[36px]">
                  Monthly credits at our best rates.
                </p>

                <div className="my-6 flex items-baseline gap-1">
                  <span className="text-3xl font-extrabold text-white">
                    US${subPrice.toFixed(2)}
                  </span>
                  <span className="text-xs text-neutral-400">/month</span>
                </div>

                <a
                  href="/register"
                  className="block text-center w-full py-2.5 px-4 rounded-lg bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] text-white font-semibold text-sm shadow-md transition-all"
                >
                  Subscribe
                </a>

                <div className="mt-8 space-y-4 pt-6 border-t border-neutral-800/80 text-xs">
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Conversion Credits</span>
                    <span className="font-semibold text-white">{credits.toLocaleString()} / month</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Cost per Credit</span>
                    <span className="font-semibold text-white">US${subCostPerCredit}</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Credit Expiry</span>
                    <span className="font-semibold text-white">Monthly reset</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 4. Enterprise Column */}
            <div className="bg-[#181818] border border-neutral-800 rounded-2xl p-6 sm:p-7 flex flex-col justify-between hover:border-neutral-700 transition-all">
              <div>
                <h3 className="text-xl font-bold text-white mb-2">Enterprise</h3>
                <p className="text-xs text-neutral-400 min-h-[36px]">
                  Custom plans for large-scale workloads.
                </p>

                <div className="my-6">
                  <span className="text-3xl font-extrabold text-white">Custom</span>
                </div>

                <a
                  href="/contact"
                  className="block text-center w-full py-2.5 px-4 rounded-lg bg-white hover:bg-neutral-100 text-neutral-900 font-semibold text-sm transition-all"
                >
                  Contact Sales
                </a>

                <div className="mt-8 space-y-4 pt-6 border-t border-neutral-800/80 text-xs">
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Conversion Credits</span>
                    <span className="font-semibold text-white">Custom</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Cost per Credit</span>
                    <span className="font-semibold text-white">Custom</span>
                  </div>
                  <div className="flex justify-between items-center text-neutral-300">
                    <span className="text-neutral-400">Credit Expiry</span>
                    <span className="font-semibold text-white">Custom</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 1:1 Detailed Comparison Matrix Tables matching CloudConvert */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl overflow-hidden shadow-xl">
            {/* Features Table */}
            <div className="p-6 sm:p-8 border-b border-neutral-800">
              <h3 className="text-lg font-bold text-white uppercase tracking-wider mb-6 pb-2 border-b border-neutral-800">
                Features
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 text-neutral-400">
                      <th className="py-3 px-4 font-semibold w-2/5">Feature</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Free</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Package</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Subscription</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Enterprise</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800/60 text-neutral-300">
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">All API Features</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">All Bandwidth Included</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Processing Priority</td>
                      <td className="py-3.5 px-4 text-center text-neutral-400">Low</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">High</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">High</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">High</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Max File Size</td>
                      <td className="py-3.5 px-4 text-center text-neutral-400">1 GB</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Max Processing Time</td>
                      <td className="py-3.5 px-4 text-center text-neutral-400">5 minutes</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Concurrent Tasks</td>
                      <td className="py-3.5 px-4 text-center text-neutral-400">5</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Unlimited</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Dedicated Capacity</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-white font-semibold">Optional</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Install Custom Fonts</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Support & Compliance Table */}
            <div className="p-6 sm:p-8">
              <h3 className="text-lg font-bold text-white uppercase tracking-wider mb-6 pb-2 border-b border-neutral-800">
                Support & Compliance
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 text-neutral-400">
                      <th className="py-3 px-4 font-semibold w-2/5">Capability</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Free</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Package</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Subscription</th>
                      <th className="py-3 px-4 font-semibold text-center w-[15%]">Enterprise</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800/60 text-neutral-300">
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Support</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-300">Standard</td>
                      <td className="py-3.5 px-4 text-center text-neutral-300">Standard</td>
                      <td className="py-3.5 px-4 text-center text-[#5C6BC0] font-bold">Priority</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">99.9% SLA</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Data Processing Agreement</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Auto-Refill</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Team Billing</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">SSO / SAML 2.0</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Custom Security Reviews</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Custom Contracts & NDAs</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-3.5 px-4 font-medium text-white">Metered Billing / Invoicing</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center text-neutral-500">—</td>
                      <td className="py-3.5 px-4 text-center"><Check className="w-4 h-4 text-[#5C6BC0] mx-auto" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ Accordion Section matching CloudConvert */}
        <section className="py-16 px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Frequently Asked Questions</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Have questions about credits or billing? We have answers.
            </p>
          </div>

          <div className="space-y-4">
            {/* 1. What are conversion credits? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 0 ? null : 0)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>What are conversion credits?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 0 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 0 && (
                <div className="px-6 pb-5 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-4 space-y-4">
                  <p>
                    The longer a conversion takes, the more resources it consumes and the more expensive it becomes. Our packages and subscriptions typically consume one credit per minute of conversion time.
                  </p>
                  <p>
                    Depending on the conversion type, each conversion also has a base credit cost. By default, conversions consume at least one credit, with additional credits charged for every extra minute if the conversion takes longer than one minute. We also offer a few premium conversion types that require more resources and therefore have a minimum base cost of two credits. Of course, only successful conversions are charged.
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-neutral-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-800/80 text-white font-semibold">
                        <tr>
                          <th className="py-2.5 px-4">Conversion Type</th>
                          <th className="py-2.5 px-4 text-right">Base Credits</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-800 text-neutral-300">
                        <tr>
                          <td className="py-2 px-4">General</td>
                          <td className="py-2 px-4 text-right font-mono font-bold">1</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-4">Office to PDF</td>
                          <td className="py-2 px-4 text-right font-mono font-bold">2</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-4">iWork to PDF</td>
                          <td className="py-2 px-4 text-right font-mono font-bold">2</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-4">PDF to Office</td>
                          <td className="py-2 px-4 text-right font-mono font-bold">4</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsCalculatorOpen(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs border border-neutral-700 transition-colors shadow-sm"
                  >
                    <Calculator className="w-3.5 h-3.5 text-[#5C6BC0]" />
                    <span>Credits Calculator</span>
                  </button>
                </div>
              )}
            </div>

            {/* 2. Why do I have to pay for a base amount of credits per conversion? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 1 ? null : 1)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>Why do I have to pay for a base amount of credits per conversion?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 1 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 1 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  Ninety-five percent of our conversions take only a few seconds, and we already account for that. To make costs more predictable, our pricing is based on a combination of the minimum credits consumed per conversion type and the total conversion time.
                </div>
              )}
            </div>

            {/* 3. What is the difference between a package and a subscription? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 2 ? null : 2)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>What is the difference between a package and a subscription?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 2 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 2 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  Packages are one-time purchases — your credits never expire and you can use them whenever you like (&quot;pay as you go&quot;). Subscriptions charge a monthly fee for a fixed amount of credits at a lower per-credit price, but unused credits do not roll over at the end of the month. Subscriptions can be up to 50% cheaper than packages.
                </div>
              )}
            </div>

            {/* 4. Can I combine packages and subscriptions? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 3 ? null : 3)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>Can I combine packages and subscriptions?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 3 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 3 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  Yes! Your credits from your monthly subscription will be consumed first, and then your package credits will be consumed.
                </div>
              )}
            </div>

            {/* 5. How can I make sure my account never runs out of credits? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 4 ? null : 4)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>How can I make sure my account never runs out of credits?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 4 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 4 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  An auto-refill option is available for packages. When enabled, your account is automatically refilled as soon as it runs out of credits. You can activate it in the billing settings.
                </div>
              )}
            </div>

            {/* 6. Can I share my package/subscription with multiple accounts? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 5 ? null : 5)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>Can I share my package/subscription with multiple accounts?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 5 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 5 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  Yes. Team billing is available, so organizations such as companies or schools can use one central billing account with unlimited team members. Only billing is shared across accounts; files and conversions remain private with our zero-retention guarantee.
                </div>
              )}
            </div>

            {/* 7. When can I cancel/change my subscription? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 6 ? null : 6)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>When can I cancel/change my subscription?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 6 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 6 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  You can cancel your subscription at any time. There is no minimum term. You can also switch to a different subscription at any time, but any remaining conversion credits will expire at the end of the billing period.
                </div>
              )}
            </div>

            {/* 8. Which payment methods are available? */}
            <div className="border border-neutral-800 rounded-xl bg-neutral-900/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === 7 ? null : 7)}
                className="w-full px-6 py-4 text-left flex items-center justify-between text-sm sm:text-base font-semibold text-white hover:text-[#5C6BC0] transition-colors"
              >
                <span>Which payment methods are available?</span>
                <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${openFaq === 7 ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>
              {openFaq === 7 && (
                <div className="px-6 pb-4 text-xs sm:text-sm text-neutral-300 leading-relaxed border-t border-neutral-800/60 pt-3">
                  We accept all major credit cards including Visa, MasterCard, and American Express. Invoicing and wire transfer are also supported for Enterprise contracts.
                </div>
              )}
            </div>
          </div>

          {/* CTA Box matching CloudConvert */}
          <div className="mt-16 bg-[#1a1a1a] border border-neutral-800 rounded-2xl p-8 sm:p-10 text-center shadow-2xl">
            <h3 className="text-2xl sm:text-3xl font-bold text-white mb-2">Ready to get started?</h3>
            <p className="text-sm text-neutral-400 max-w-lg mx-auto mb-6">
              Start free with 10 conversions per day. No credit card required.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <a
                href="/register"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#5C6BC0] hover:bg-[#4d5cb5] text-white font-bold text-sm shadow-lg shadow-[#5C6BC0]/25 transition-all"
              >
                <span>Get Started Free</span>
                <ArrowRight className="w-4 h-4" />
              </a>
              <a
                href="/contact"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-neutral-700 hover:border-neutral-500 bg-neutral-900/60 text-white font-semibold text-sm transition-all"
              >
                <span>Contact Sales</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* 1:1 Credits Calculator Modal matching CloudConvert */}
      {isCalculatorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setIsCalculatorOpen(false)}
        >
          <div
            className="relative w-full max-w-lg bg-[#1e1e1e] border border-neutral-700/80 rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 sm:px-6 border-b border-neutral-800 flex items-center justify-between bg-neutral-900/50">
              <div className="flex items-center gap-2">
                <Calculator className="w-5 h-5 text-[#5C6BC0]" />
                <h3 className="text-base font-bold text-white">Credits Calculator</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCalculatorOpen(false)}
                aria-label="Close"
                className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5 text-sm">
              {/* Operation */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
                  Operation
                </label>
                <select
                  value={calcOperation}
                  onChange={(e) => setCalcOperation(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] text-sm"
                >
                  <option value="convert">Convert</option>
                  <option value="compress">Compress / Optimize</option>
                  <option value="thumbnail">Create Thumbnail</option>
                  <option value="capture">Capture Website</option>
                  <option value="merge">Merge</option>
                </select>
              </div>

              {calcOperation === 'convert' ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
                        Input Format
                      </label>
                      <select
                        value={calcInputFmt}
                        onChange={(e) => setCalcInputFmt(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] text-xs uppercase"
                      >
                        {Object.keys(FORMAT_REGISTRY).map((fmt) => (
                          <option key={fmt} value={fmt}>
                            {fmt.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
                        Output Format
                      </label>
                      <select
                        value={calcOutputFmt}
                        onChange={(e) => setCalcOutputFmt(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] text-xs uppercase"
                      >
                        {(FORMAT_REGISTRY[calcInputFmt]?.targetFormats || ['pdf', 'docx', 'png']).map(
                          (fmt) => (
                            <option key={fmt} value={fmt}>
                              {fmt.toUpperCase()}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>

                  {/* Calculation Result */}
                  <div className="p-4 rounded-xl bg-neutral-900/90 border border-neutral-800 space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-neutral-400">Base credit cost:</span>
                      <span className="font-mono font-bold text-white text-sm">
                        {baseCreditsCalculated} {baseCreditsCalculated === 1 ? 'credit' : 'credits'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-neutral-400">Conversion time rate:</span>
                      <span className="text-neutral-300 font-medium">
                        1 credit / minute
                      </span>
                    </div>
                    <p className="text-[11px] text-neutral-400 pt-2 border-t border-neutral-800">
                      Most standard conversions take 5-15 seconds and consume exactly{' '}
                      <span className="text-white font-semibold">{baseCreditsCalculated} credit{baseCreditsCalculated > 1 ? 's' : ''}</span>.
                    </p>
                  </div>
                </>
              ) : (
                <div className="p-4 rounded-xl bg-neutral-900/90 border border-neutral-800 space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-neutral-400">Base credit cost:</span>
                    <span className="font-mono font-bold text-white text-sm">1 credit</span>
                  </div>
                  <p className="text-[11px] text-neutral-400 pt-2 border-t border-neutral-800">
                    Operation requires standard compute resources and consumes 1 credit per minute.
                  </p>
                </div>
              )}
            </div>

            <div className="p-4 bg-neutral-900/50 border-t border-neutral-800 flex justify-end">
              <button
                type="button"
                onClick={() => setIsCalculatorOpen(false)}
                className="px-4 py-2 rounded-xl bg-[#5C6BC0] hover:bg-[#4d5cb5] text-white font-semibold text-xs transition-colors"
              >
                Close Calculator
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
