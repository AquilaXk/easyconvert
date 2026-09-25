'use client';

import React from 'react';
import { Github, Shield } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-neutral-800 bg-[#161616] text-neutral-400 transition-colors mt-auto text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-10">
          {/* Brand Info */}
          <div className="space-y-3 col-span-2 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-[#5C6BC0] flex items-center justify-center text-white shadow-sm shadow-[#5C6BC0]/30">
                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                </svg>
              </div>
              <span className="text-base tracking-tight text-white font-sans lowercase">
                <span className="font-normal">easy</span>
                <span className="font-bold">convert</span>
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 leading-relaxed max-w-xs">
              Universal file conversion service with our signature lavender palette, transient
              in-memory stream processing, and 100% zero data retention.
            </p>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
              Company
            </h4>
            <ul className="space-y-2">
              <li>
                <a href="/about" className="hover:text-white transition-colors">
                  About Us
                </a>
              </li>
              <li>
                <a href="/security" className="hover:text-white transition-colors">
                  Security
                </a>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
              Resources
            </h4>
            <ul className="space-y-2">
              <li>
                <a href="/pricing" className="hover:text-white transition-colors">
                  Pricing &amp; Plans
                </a>
              </li>
              <li>
                <a href="/api/v2" className="hover:text-white transition-colors">
                  API Documentation
                </a>
              </li>
              <li>
                <a href="/api/formats" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
                  Format Matrix
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
              Legal
            </h4>
            <ul className="space-y-2">
              <li>
                <a href="/privacy" className="hover:text-white transition-colors">
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="/terms" className="hover:text-white transition-colors">
                  Terms of Service
                </a>
              </li>
            </ul>
          </div>

          {/* Contact & Status */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
              Contact
            </h4>
            <ul className="space-y-2">
              <li>
                <a href="/contact" className="hover:text-white transition-colors">
                  Contact Us
                </a>
              </li>
              <li className="flex items-center gap-1.5 pt-1 text-emerald-400 text-[11px]">
                <Shield className="w-3.5 h-3.5" />
                <span>Zero Data Retention Active</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="pt-6 border-t border-neutral-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-neutral-500 text-[11px]">
          <p>&copy; {new Date().getFullYear()} EasyConvert. High-Density Universal File Conversion.</p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/AquilaXk/easyconvert"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-white transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              <span>AquilaXk/easyconvert</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
