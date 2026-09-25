'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  ChevronDown,
  Calculator,
  HelpCircle,
  Zap,
} from 'lucide-react';
import { TIERS, calculateBaseCredits } from '@/lib/pricing';

export default function PricingPage() {
  const [sliderIndex, setSliderIndex] = useState(1); // Default to 1,000 credits
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

  const CheckIcon = () => (
    <svg className="size-5 shrink-0 text-[#d9383a]" viewBox="0 0 512 512" fill="currentColor">
      <path d="M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zM374 145.7c-10.7-7.8-25.7-5.4-33.5 5.3L221.1 315.2 169 263.1c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9l72 72c5 5 11.8 7.5 18.8 7s13.4-4.1 17.5-9.8L379.3 179.2c7.8-10.7 5.4-25.7-5.3-33.5z" />
    </svg>
  );

  const MinusIcon = () => (
    <svg className="size-5 shrink-0 text-neutral-600" viewBox="0 0 448 512" fill="currentColor">
      <path d="M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z" />
    </svg>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#18191d] text-white">
      <Header />

      <main className="flex-1">
        {/* Top Hero Section matching CloudConvert */}
        <section className="relative overflow-hidden bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 pt-28 pb-16">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,40,40,0.25),transparent)] pointer-events-none" />
          <div
            className="absolute inset-0 opacity-[0.05] pointer-events-none"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cpattern id='g' width='60' height='60' patternUnits='userSpaceOnUse'%3E%3Cpath d='M 60 0 L 0 0 0 60' fill='none' stroke='white' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23g)'/%3E%3C/svg%3E")`,
            }}
          />
          <div className="relative mx-auto max-w-7xl px-6 lg:grid lg:grid-cols-2 lg:items-center lg:gap-12">
            <div className="text-center lg:text-left">
              <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
                Pricing
              </h1>
              <p className="mx-auto mt-6 max-w-3xl text-lg leading-relaxed text-neutral-300 lg:mx-0">
                Pay only for what you need. Use the slider to choose the number of conversion credits you want, and see prices update instantly.
              </p>
            </div>

            <div className="mx-auto mt-8 w-full max-w-xl rounded-2xl border border-white/[0.08] bg-white/[0.04] p-6 backdrop-blur-sm lg:mt-0 lg:justify-self-end">
              <label className="mb-6 block text-sm font-medium tracking-wide text-neutral-400 uppercase text-center">
                Select your volume
              </label>
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-4xl font-bold tabular-nums text-white sm:text-5xl">
                  {credits.toLocaleString()}
                </span>
                <span className="text-base text-neutral-400">credits</span>
              </div>
              <div className="mt-8 px-2">
                <input
                  type="range"
                  min={0}
                  max={TIERS.length - 1}
                  step={1}
                  value={sliderIndex}
                  onChange={(e) => setSliderIndex(Number(e.target.value))}
                  className="pricing-slider"
                  style={{
                    background: `linear-gradient(to right, #d9383a ${(sliderIndex / (TIERS.length - 1)) * 100}%, #2A2E33 ${(sliderIndex / (TIERS.length - 1)) * 100}%)`,
                  }}
                  aria-label="Volume slider"
                />
              </div>
              <div className="mt-2 flex justify-between text-xs text-neutral-500">
                <span>500</span>
                <span>1,000,000</span>
              </div>
              <p className="mt-3 text-sm text-neutral-400 text-center">
                Packages from <strong className="text-white">US${packagePrice.toFixed(2)}</strong> · Subscriptions from <strong className="text-white">US${subPrice.toFixed(2)}/month</strong>
              </p>
            </div>
          </div>
        </section>

        {/* Unified Comparison Matrix Table Section */}
        <section className="py-8 lg:py-12">
          <div className="mx-auto max-w-7xl px-6">
            <div className="w-full relative">
              {/* Desktop Matrix Table */}
              <table className="w-full table-fixed border-separate border-spacing-x-0 hidden md:table h-fit text-sm [&_td:nth-child(4)]:border-l-0 [&_th:nth-child(4)]:border-l-0">
                <thead>
                  <tr>
                    <td className="w-1/4"></td>

                    {/* Free Column */}
                    <th scope="col" className="p-6 text-start font-normal align-top h-full w-[18.75%]">
                      <div className="flex flex-col h-full">
                        <div className="text-lg font-semibold text-white">Free</div>
                        <div className="text-sm font-normal text-neutral-400 mt-1 min-h-[40px]">
                          For personal use, testing and hobby projects.
                        </div>
                        <div className="flex items-center gap-1 mt-4">
                          <div className="text-white text-2xl sm:text-3xl font-semibold whitespace-nowrap">
                            US$0
                          </div>
                        </div>
                        <div className="mt-6 pt-6">
                          <a
                            href="/register"
                            className="rounded-md font-medium inline-flex items-center px-3 py-2 text-sm gap-2 w-full justify-center border border-neutral-700 text-white bg-transparent hover:bg-white/5 transition-colors"
                          >
                            Sign Up
                          </a>
                        </div>
                      </div>
                    </th>

                    {/* Package Column */}
                    <th scope="col" className="p-6 text-start font-normal align-top h-full w-[18.75%] bg-[#212529] border-l border-r border-t border-neutral-700/80 rounded-tl-lg rounded-tr-none">
                      <div className="flex flex-col h-full">
                        <div className="text-lg font-semibold text-white">Package</div>
                        <div className="text-sm font-normal text-neutral-400 mt-1 min-h-[40px]">
                          One-time payment. Credits never expire.
                        </div>
                        <div className="flex items-center gap-1 mt-4">
                          <div className="text-white text-2xl sm:text-3xl font-semibold whitespace-nowrap">
                            US${packagePrice.toFixed(2)}
                          </div>
                        </div>
                        <div className="mt-6 pt-6">
                          <a
                            href="/register"
                            className="rounded-md font-medium inline-flex items-center px-3 py-2 text-sm gap-2 w-full justify-center text-white bg-[#d9383a] hover:bg-[#c22e30] transition-colors shadow-sm"
                          >
                            Buy Now
                          </a>
                        </div>
                      </div>
                    </th>

                    {/* Subscription Column */}
                    <th scope="col" className="p-6 text-start font-normal align-top h-full w-[18.75%] bg-[#212529] border-r border-t border-neutral-700/80 rounded-tr-lg rounded-tl-none">
                      <div className="flex flex-col h-full">
                        <div className="text-lg font-semibold text-white">Subscription</div>
                        <div className="text-sm font-normal text-neutral-400 mt-1 min-h-[40px]">
                          Monthly credits at our best rates.
                        </div>
                        <div className="flex items-baseline gap-1 mt-4">
                          <div className="text-white text-2xl sm:text-3xl font-semibold whitespace-nowrap">
                            US${subPrice.toFixed(2)}
                          </div>
                          <span className="text-neutral-400 text-xs font-medium">/month</span>
                        </div>
                        <div className="mt-6 pt-6">
                          <a
                            href="/register"
                            className="rounded-md font-medium inline-flex items-center px-3 py-2 text-sm gap-2 w-full justify-center text-white bg-[#d9383a] hover:bg-[#c22e30] transition-colors shadow-sm"
                          >
                            Subscribe
                          </a>
                        </div>
                      </div>
                    </th>

                    {/* Enterprise Column */}
                    <th scope="col" className="p-6 text-start font-normal align-top h-full w-[18.75%]">
                      <div className="flex flex-col h-full">
                        <div className="text-lg font-semibold text-white">Enterprise</div>
                        <div className="text-sm font-normal text-neutral-400 mt-1 min-h-[40px]">
                          Custom plans for large-scale workloads.
                        </div>
                        <div className="flex items-center gap-1 mt-4">
                          <div className="text-white text-2xl sm:text-3xl font-semibold whitespace-nowrap">
                            Custom
                          </div>
                        </div>
                        <div className="mt-6 pt-6">
                          <a
                            href="/contact"
                            className="rounded-md font-medium inline-flex items-center px-3 py-2 text-sm gap-2 w-full justify-center text-black bg-white hover:bg-neutral-200 transition-colors"
                          >
                            Contact Sales
                          </a>
                        </div>
                      </div>
                    </th>
                  </tr>
                </thead>

                <tbody className="[&>tr:nth-child(1)]:hidden">
                  {/* SECTION 1: Pricing */}
                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800">
                      <div className="font-semibold text-sm text-white">Pricing</div>
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"></td>
                  </tr>

                  {/* Row: Conversion Credits */}
                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800">
                      <span className="text-sm font-bold text-white">Conversion Credits</span>
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800">
                      <span className="text-sm font-bold text-white">10 / day</span>
                    </td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80">
                      <div className="flex flex-col items-center gap-1.5 w-full min-w-25">
                        <span className="text-sm font-bold text-white">{credits.toLocaleString()}</span>
                        <div className="w-full px-0.5">
                          <input
                            type="range"
                            min={0}
                            max={TIERS.length - 1}
                            value={sliderIndex}
                            onChange={(e) => setSliderIndex(Number(e.target.value))}
                            className="table-slider"
                            style={{
                              background: `linear-gradient(to right, #d9383a ${(sliderIndex / (TIERS.length - 1)) * 100}%, #2A2E33 ${(sliderIndex / (TIERS.length - 1)) * 100}%)`,
                            }}
                            aria-label="Package slider"
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80">
                      <div className="flex flex-col items-center gap-1.5 w-full min-w-25">
                        <span className="text-sm font-bold text-white">{credits.toLocaleString()} / month</span>
                        <div className="w-full px-0.5">
                          <input
                            type="range"
                            min={0}
                            max={TIERS.length - 1}
                            value={sliderIndex}
                            onChange={(e) => setSliderIndex(Number(e.target.value))}
                            className="table-slider"
                            style={{
                              background: `linear-gradient(to right, #d9383a ${(sliderIndex / (TIERS.length - 1)) * 100}%, #2A2E33 ${(sliderIndex / (TIERS.length - 1)) * 100}%)`,
                            }}
                            aria-label="Subscription slider"
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800">
                      <span className="text-sm font-bold text-white">Custom</span>
                    </td>
                  </tr>

                  {/* Row: Cost per Credit */}
                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Cost per Credit
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Free</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">
                      US${pkgCostPerCredit}
                    </td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">
                      US${subCostPerCredit}
                    </td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Custom</td>
                  </tr>

                  {/* Row: Credit Expiry */}
                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Credit Expiry
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Daily reset</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Never</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Monthly reset</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Custom</td>
                  </tr>

                  {/* SECTION 2: Features */}
                  <tr>
                    <th scope="row" className="py-4 pt-8 font-normal text-start border-b border-neutral-800">
                      <div className="font-semibold text-sm text-white">Features</div>
                    </th>
                    <td className="px-6 py-4 pt-8 text-center border-b border-neutral-800"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b border-neutral-800"></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      All API Features
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      All Bandwidth Included
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Processing Priority
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Low</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">High</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">High</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">High</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Max File Size
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">1 GB</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Unlimited</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Max Processing Time
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">5 minutes</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Unlimited</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Concurrent Tasks
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">5</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Unlimited</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Unlimited</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Dedicated Capacity
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Optional</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Install Custom Fonts
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  {/* SECTION 3: Support & Compliance */}
                  <tr>
                    <th scope="row" className="py-4 pt-8 font-normal text-start border-b border-neutral-800">
                      <div className="font-semibold text-sm text-white">Support &amp; Compliance</div>
                    </th>
                    <td className="px-6 py-4 pt-8 text-center border-b border-neutral-800"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b bg-[#212529] border-x border-neutral-700/80"></td>
                    <td className="px-6 py-4 pt-8 text-center border-b border-neutral-800"></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Support
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Standard</td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 text-sm text-neutral-400">Standard</td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800 text-sm text-neutral-400">Priority</td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      99.9% SLA
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Data Processing Agreement
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Auto-Refill
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Team Billing
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><CheckIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      SSO / SAML 2.0
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Custom Security Reviews
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Custom Contracts &amp; NDAs
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>

                  <tr>
                    <th scope="row" className="py-4 font-normal text-start border-b border-neutral-800 text-sm text-neutral-300">
                      Metered Billing / Invoicing
                    </th>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 rounded-bl-lg"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b bg-[#212529] border-x border-neutral-700/80 rounded-br-lg"><div className="flex justify-center"><MinusIcon /></div></td>
                    <td className="px-6 py-4 text-center border-b border-neutral-800"><div className="flex justify-center"><CheckIcon /></div></td>
                  </tr>
                </tbody>
              </table>

              {/* Mobile View: 4 Stacked Cards */}
              <div className="md:hidden flex flex-col gap-6 w-full">
                {/* Free Mobile */}
                <div className="p-6 flex flex-col border border-neutral-800 rounded-lg bg-neutral-900/60">
                  <div className="text-lg font-semibold text-white">Free</div>
                  <div className="text-sm font-normal text-neutral-400 mt-1">For personal use, testing and hobby projects.</div>
                  <div className="text-2xl font-semibold text-white mt-4">US$0</div>
                  <a href="/register" className="mt-6 py-2 px-3 text-center border border-neutral-700 rounded-md text-sm text-white">Sign Up</a>
                  <div className="mt-6 pt-4 border-t border-neutral-800 text-xs space-y-2">
                    <div className="flex justify-between text-neutral-300"><span>Conversion Credits</span><span className="font-bold text-white">10 / day</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Cost per Credit</span><span className="text-neutral-400">Free</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Credit Expiry</span><span className="text-neutral-400">Daily reset</span></div>
                  </div>
                </div>

                {/* Package Mobile */}
                <div className="p-6 flex flex-col border border-neutral-700/80 rounded-lg bg-[#212529]">
                  <div className="text-lg font-semibold text-white">Package</div>
                  <div className="text-sm font-normal text-neutral-400 mt-1">One-time payment. Credits never expire.</div>
                  <div className="text-2xl font-semibold text-white mt-4">US${packagePrice.toFixed(2)}</div>
                  <a href="/register" className="mt-6 py-2 px-3 text-center bg-[#d9383a] hover:bg-[#c22e30] rounded-md text-sm text-white font-medium">Buy Now</a>
                  <div className="mt-6 pt-4 border-t border-neutral-800 text-xs space-y-2">
                    <div className="flex justify-between text-neutral-300"><span>Conversion Credits</span><span className="font-bold text-white">{credits.toLocaleString()}</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Cost per Credit</span><span className="text-neutral-400">US${pkgCostPerCredit}</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Credit Expiry</span><span className="text-neutral-400">Never</span></div>
                  </div>
                </div>

                {/* Subscription Mobile */}
                <div className="p-6 flex flex-col border border-neutral-700/80 rounded-lg bg-[#212529]">
                  <div className="text-lg font-semibold text-white">Subscription</div>
                  <div className="text-sm font-normal text-neutral-400 mt-1">Monthly credits at our best rates.</div>
                  <div className="text-2xl font-semibold text-white mt-4">US${subPrice.toFixed(2)} /month</div>
                  <a href="/register" className="mt-6 py-2 px-3 text-center bg-[#d9383a] hover:bg-[#c22e30] rounded-md text-sm text-white font-medium">Subscribe</a>
                  <div className="mt-6 pt-4 border-t border-neutral-800 text-xs space-y-2">
                    <div className="flex justify-between text-neutral-300"><span>Conversion Credits</span><span className="font-bold text-white">{credits.toLocaleString()} / month</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Cost per Credit</span><span className="text-neutral-400">US${subCostPerCredit}</span></div>
                    <div className="flex justify-between text-neutral-300"><span>Credit Expiry</span><span className="text-neutral-400">Monthly reset</span></div>
                  </div>
                </div>

                {/* Enterprise Mobile */}
                <div className="p-6 flex flex-col border border-neutral-800 rounded-lg bg-neutral-900/60">
                  <div className="text-lg font-semibold text-white">Enterprise</div>
                  <div className="text-sm font-normal text-neutral-400 mt-1">Custom plans for large-scale workloads.</div>
                  <div className="text-2xl font-semibold text-white mt-4">Custom</div>
                  <a href="/contact" className="mt-6 py-2 px-3 text-center bg-white text-black hover:bg-neutral-200 rounded-md text-sm font-medium">Contact Sales</a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Interactive Credits Calculator Accordion */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="bg-[#212529] border border-neutral-700/80 rounded-2xl p-6 sm:p-8 shadow-xl">
            <button
              type="button"
              onClick={() => setIsCalculatorOpen(!isCalculatorOpen)}
              className="w-full flex items-center justify-between text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#d9383a]/10 text-[#d9383a]">
                  <Calculator className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white group-hover:text-[#d9383a] transition-colors">
                    Credits Calculator
                  </h3>
                  <p className="text-xs text-neutral-400">
                    See exactly how many conversion credits each file type consumes.
                  </p>
                </div>
              </div>
              <ChevronDown
                className={`w-5 h-5 text-neutral-400 transition-transform duration-200 ${
                  isCalculatorOpen ? 'rotate-180 text-[#d9383a]' : ''
                }`}
              />
            </button>

            {isCalculatorOpen && (
              <div className="mt-6 pt-6 border-t border-neutral-700/80 animate-in fade-in duration-200 space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Operation Select */}
                  <div>
                    <label className="block text-xs font-semibold text-neutral-300 uppercase tracking-wider mb-2">
                      Operation
                    </label>
                    <select
                      value={calcOperation}
                      onChange={(e) => setCalcOperation(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs font-medium text-white focus:outline-none focus:border-[#d9383a]"
                    >
                      <option value="convert">Convert</option>
                      <option value="compress">Compress</option>
                      <option value="thumbnail">Thumbnail</option>
                      <option value="capture">Website Capture</option>
                      <option value="merge">Merge</option>
                    </select>
                  </div>

                  {/* Input Format */}
                  <div>
                    <label className="block text-xs font-semibold text-neutral-300 uppercase tracking-wider mb-2">
                      Input Format
                    </label>
                    <select
                      value={calcInputFmt}
                      onChange={(e) => setCalcInputFmt(e.target.value)}
                      disabled={calcOperation !== 'convert'}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs font-medium text-white focus:outline-none focus:border-[#d9383a] disabled:opacity-40"
                    >
                      <option value="pdf">PDF</option>
                      <option value="docx">DOCX (Office)</option>
                      <option value="xlsx">XLSX (Office)</option>
                      <option value="pptx">PPTX (Office)</option>
                      <option value="pages">Pages (Apple iWork)</option>
                      <option value="numbers">Numbers (Apple iWork)</option>
                      <option value="key">Keynote (Apple iWork)</option>
                      <option value="png">PNG (Raster Image)</option>
                      <option value="mp4">MP4 (Video)</option>
                    </select>
                  </div>

                  {/* Output Format */}
                  <div>
                    <label className="block text-xs font-semibold text-neutral-300 uppercase tracking-wider mb-2">
                      Output Format
                    </label>
                    <select
                      value={calcOutputFmt}
                      onChange={(e) => setCalcOutputFmt(e.target.value)}
                      disabled={calcOperation !== 'convert'}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs font-medium text-white focus:outline-none focus:border-[#d9383a] disabled:opacity-40"
                    >
                      <option value="docx">DOCX (Office Word)</option>
                      <option value="pdf">PDF Document</option>
                      <option value="xlsx">XLSX (Excel)</option>
                      <option value="pptx">PPTX (PowerPoint)</option>
                      <option value="jpg">JPG (Image)</option>
                      <option value="mp3">MP3 (Audio)</option>
                    </select>
                  </div>
                </div>

                {/* Calculation Result */}
                <div className="p-4 rounded-xl bg-neutral-900/90 border border-neutral-700/80 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Zap className="w-5 h-5 text-[#d9383a]" />
                    <span className="text-xs text-neutral-300">
                      Calculated Base Cost for <strong>{calcOperation}</strong>
                      {calcOperation === 'convert' && ` (${calcInputFmt.toUpperCase()} → ${calcOutputFmt.toUpperCase()})`}:
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-black text-[#d9383a]">
                      {baseCreditsCalculated}
                    </span>
                    <span className="text-xs text-neutral-400 font-semibold uppercase">
                      Credit{baseCreditsCalculated > 1 ? 's' : ''} / file
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* FAQ Accordion Section */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="text-center mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Frequently Asked Questions</h2>
            <p className="mt-2 text-sm text-neutral-400">Everything you need to know about our billing and credits.</p>
          </div>

          <div className="space-y-4">
            {[
              {
                q: 'What is a conversion credit?',
                a: 'A conversion credit is a standard metering unit used by EasyConvert. Simple conversions (such as PNG to JPG or MP4 to MP3) require 1 credit. High-fidelity Office conversions (e.g. DOCX or XLSX to PDF) require 2 credits, while converting complex PDFs back into editable Office documents requires 4 credits.',
              },
              {
                q: 'Do package credits expire?',
                a: 'No. Credits purchased as a Package never expire and can be consumed at your own pace over months or years.',
              },
              {
                q: 'How do Subscriptions work?',
                a: 'Subscriptions renew each month at approximately 50% discount compared to one-time packages. Unused subscription credits reset at the start of each billing period.',
              },
              {
                q: 'Is there a free tier?',
                a: 'Yes! Every registered user receives 10 free conversion credits per day with a 1 GB maximum file size limit.',
              },
              {
                q: 'Can I cancel my subscription anytime?',
                a: 'Yes, subscriptions can be cancelled immediately at any time from your account settings with zero cancellation penalties.',
              },
            ].map((faq, idx) => (
              <div
                key={idx}
                className="bg-[#212529] border border-neutral-700/80 rounded-xl overflow-hidden transition-all"
              >
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === idx ? null : idx)}
                  className="w-full flex items-center justify-between p-5 text-left text-sm font-semibold text-white hover:text-[#d9383a] transition-colors"
                >
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="w-4 h-4 text-[#d9383a]" />
                    <span>{faq.q}</span>
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${
                      openFaq === idx ? 'rotate-180 text-[#d9383a]' : ''
                    }`}
                  />
                </button>
                {openFaq === idx && (
                  <div className="px-5 pb-5 pt-1 text-xs text-neutral-400 leading-relaxed border-t border-neutral-700/80 animate-in fade-in duration-150">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
