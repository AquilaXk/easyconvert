'use client';

import React, { useState, useEffect } from 'react';

export default function Footer() {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  const toggleDarkMode = () => {
    if (isDark) {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
      setIsDark(false);
    } else {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
      setIsDark(true);
    }
  };

  return (
    <footer className="bg-neutral-100/70 dark:bg-[#18191d]/80 border-t border-neutral-200 dark:border-neutral-800 transition-colors mt-auto">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:flex lg:justify-between lg:gap-x-3 lg:items-start lg:py-8">
        {/* Right Section (order-3): Theme Switch */}
        <div className="lg:flex-1 flex items-center justify-center lg:justify-end gap-x-1.5 lg:order-3">
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="rounded-md font-medium inline-flex items-center text-sm gap-1.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-white/5 transition-colors p-1.5 cursor-pointer"
          >
            {isDark ? (
              <svg className="size-4 shrink-0 text-neutral-400 hover:text-white" viewBox="0 0 512 512" fill="currentColor">
                <path d="M256 0C114.6 0 0 114.6 0 256S114.6 512 256 512c68.8 0 131.3-27.2 177.3-71.4 7.3-7 9.4-17.9 5.3-27.1s-13.7-14.9-23.8-14.1c-4.9 .4-9.8 .6-14.8 .6-101.6 0-184-82.4-184-184 0-72.1 41.5-134.6 102.1-164.8 9.1-4.5 14.3-14.3 13.1-24.4S322.6 8.5 312.7 6.3C294.4 2.2 275.4 0 256 0z" />
              </svg>
            ) : (
              <svg className="size-4 shrink-0 text-neutral-500 hover:text-neutral-900" viewBox="0 0 512 512" fill="currentColor">
                <path d="M232 488c0 13.3 10.7 24 24 24s24-10.7 24-24l0-56c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 56zm0-408c0 13.3 10.7 24 24 24s24-10.7 24-24l0-56c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 56zM75 75c-9.4 9.4-9.4 24.6 0 33.9l39.6 39.6c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9L108.9 75c-9.4-9.4-24.6-9.4-33.9 0zM363.5 363.5c-9.4 9.4-9.4 24.6 0 33.9L403.1 437c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-39.6-39.6c-9.4-9.4-24.6-9.4-33.9 0zM0 256c0 13.3 10.7 24 24 24l56 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-56 0c-13.3 0-24 10.7-24 24zm408 0c0 13.3 10.7 24 24 24l56 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-56 0c-13.3 0-24 10.7-24 24zM75 437c9.4 9.4 24.6 9.4 33.9 0l39.6-39.6c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0L75 403.1c-9.4 9.4-9.4 24.6 0 33.9zM363.5 148.5c9.4 9.4 24.6 9.4 33.9 0L437 108.9c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-39.6 39.6c-9.4 9.4-9.4 24.6 0 33.9zM256 368a112 112 0 1 0 0-224 112 112 0 1 0 0 224z" />
              </svg>
            )}
          </button>
        </div>

        {/* Center Section (order-2): 4-Column Navigation */}
        <div className="lg:mt-0 lg:order-2 flex items-center justify-center mt-8">
          <nav className="xl:grid xl:gap-8 xl:grid-cols-2">
            <div className="flex-col lg:grid auto-cols-fr gap-8 xl:col-span-2 grid grid-cols-2 grid-flow-row md:grid-flow-col">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Company</h3>
                <ul className="space-y-4 mt-4">
                  <li>
                    <a href="/about" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      About Us
                    </a>
                  </li>
                  <li>
                    <a href="/security" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Security
                    </a>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Resources</h3>
                <ul className="space-y-4 mt-4">
                  <li>
                    <a href="/pricing" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Pricing
                    </a>
                  </li>
                  <li>
                    <a href="/api/v2" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Status
                    </a>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Legal</h3>
                <ul className="space-y-4 mt-4">
                  <li>
                    <a href="/privacy" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Privacy
                    </a>
                  </li>
                  <li>
                    <a href="/terms" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Terms
                    </a>
                  </li>
                  <li>
                    <a href="/about#imprint" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Imprint
                    </a>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Contact</h3>
                <ul className="space-y-4 mt-4">
                  <li>
                    <a href="/contact" className="group text-sm font-normal text-[#5C6BC0] dark:text-[#7480D2] hover:underline transition-colors">
                      Contact Us
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </nav>
        </div>

        {/* Left Section (order-1): Copyright and Tagline */}
        <div className="flex items-center justify-center lg:justify-start lg:flex-1 gap-x-1.5 lg:mt-0 lg:order-1 flex-col lg:items-start mt-8">
          <div className="text-sm font-normal text-neutral-800 dark:text-neutral-300">© 2026 EasyConvert Inc.</div>
          <div className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">Universal High-Density File Conversion</div>
        </div>
      </div>
    </footer>
  );
}

