'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Check, AlertCircle } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (!termsAccepted) {
      setError('You must accept the terms and conditions to proceed.');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await new Promise((r) => setTimeout(r, 400));
      localStorage.setItem('easyconvert_user', email.trim());
      router.push('/');
    } catch {
      setError('Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#141414] text-white">
      <Header />

      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-16">
        {/* Title & Subtitle Above Card */}
        <div className="w-full max-w-[520px] mb-6 text-left">
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Sign Up</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Already have an account?{' '}
            <a
              href="/login"
              className="text-[#5C6BC0] hover:text-[#7986CB] font-medium transition-colors"
            >
              Sign in
            </a>
            .
          </p>
        </div>

        {/* Register Card */}
        <div className="w-full max-w-[520px] bg-[#1e1e1e] border border-neutral-800 rounded-2xl p-7 sm:p-9 shadow-2xl animate-in fade-in duration-200">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            {/* Email Address */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-center">
              <label
                htmlFor="regEmail"
                className="text-xs font-semibold text-neutral-300 sm:text-right"
              >
                Email Address
              </label>
              <div className="sm:col-span-2">
                <input
                  id="regEmail"
                  type="email"
                  required
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] focus:border-transparent transition-all"
                />
              </div>
            </div>

            {/* Password */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-center">
              <label
                htmlFor="regPassword"
                className="text-xs font-semibold text-neutral-300 sm:text-right"
              >
                Password
              </label>
              <div className="sm:col-span-2 relative">
                <input
                  id="regPassword"
                  type={showPassword ? 'text' : 'password'}
                  required
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] focus:border-transparent transition-all pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                  aria-label="Toggle password visibility"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Password */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-center">
              <label
                htmlFor="regConfirmPassword"
                className="text-xs font-semibold text-neutral-300 sm:text-right"
              >
                Confirm Password
              </label>
              <div className="sm:col-span-2 relative">
                <input
                  id="regConfirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  required
                  placeholder="Confirm Password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] focus:border-transparent transition-all pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                  aria-label="Toggle confirm password visibility"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Terms Checkbox */}
            <div className="pt-2 flex items-center gap-2 sm:pl-[33%]">
              <input
                id="terms"
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-[#5C6BC0] focus:ring-[#5C6BC0]"
              />
              <label htmlFor="terms" className="text-xs text-neutral-400 select-none cursor-pointer">
                I accept the{' '}
                <a
                  href="/terms"
                  className="text-[#5C6BC0] hover:text-[#7986CB] underline transition-colors"
                >
                  terms and conditions
                </a>
                .
              </label>
            </div>

            {/* Sign Up Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] text-white font-semibold text-sm shadow-md transition-all flex items-center justify-center gap-2"
              >
                {loading ? <span>Creating account...</span> : <span>Sign Up</span>}
              </button>
            </div>
          </form>
        </div>
      </main>

      <Footer />
    </div>
  );
}
