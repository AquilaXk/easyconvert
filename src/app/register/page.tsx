'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, AlertCircle } from 'lucide-react';

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
    <div className="flex flex-col min-h-screen bg-[#18191d] text-white">
      <Header />

      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-12">
        <div className="w-full max-w-md">
          {/* Header above card */}
          <div className="mb-4">
            <h1 className="text-xl font-bold text-white tracking-tight">Sign Up</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Already have an account?{' '}
              <a href="/login" className="text-[#5C6BC0] hover:underline font-medium">
                Sign in
              </a>
              .
            </p>
          </div>

          {/* Sharp rectangular card */}
          <div className="rounded-none bg-[#212529]/50 ring-1 ring-neutral-700/80 shadow-2xl p-4 sm:p-6 animate-in fade-in duration-200">
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-2.5 rounded bg-red-950/50 border border-red-500/50 text-red-300 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{error}</span>
                </div>
              )}

              {/* Email Address row */}
              <div className="text-sm flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <label htmlFor="regEmail" className="w-full sm:w-1/3 block font-medium text-neutral-300 text-xs sm:text-sm">
                  Email Address
                </label>
                <div className="w-full sm:w-2/3">
                  <input
                    id="regEmail"
                    type="email"
                    required
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-md border-0 bg-[#18191d] ring-1 ring-inset ring-neutral-700/80 focus:ring-1 focus:ring-[#5C6BC0] px-2.5 py-1.5 text-sm text-white placeholder-neutral-500 outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="border-t border-neutral-700/60 w-full" />

              {/* Password row */}
              <div className="text-sm flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <label htmlFor="regPassword" className="w-full sm:w-1/3 block font-medium text-neutral-300 text-xs sm:text-sm">
                  Password
                </label>
                <div className="w-full sm:w-2/3 relative">
                  <input
                    id="regPassword"
                    type={showPassword ? 'text' : 'password'}
                    required
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border-0 bg-[#18191d] ring-1 ring-inset ring-neutral-700/80 focus:ring-1 focus:ring-[#5C6BC0] px-2.5 py-1.5 text-sm text-white placeholder-neutral-500 outline-none transition-colors pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                    aria-label="Toggle password visibility"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="border-t border-neutral-700/60 w-full" />

              {/* Confirm Password row */}
              <div className="text-sm flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <label htmlFor="regConfirmPassword" className="w-full sm:w-1/3 block font-medium text-neutral-300 text-xs sm:text-sm">
                  Confirm Password
                </label>
                <div className="w-full sm:w-2/3 relative">
                  <input
                    id="regConfirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    placeholder="Confirm Password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-md border-0 bg-[#18191d] ring-1 ring-inset ring-neutral-700/80 focus:ring-1 focus:ring-[#5C6BC0] px-2.5 py-1.5 text-sm text-white placeholder-neutral-500 outline-none transition-colors pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                    aria-label="Toggle confirm password visibility"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="border-t border-neutral-700/60 w-full" />

              {/* Terms Checkbox */}
              <div className="flex items-center gap-2 pt-1 text-sm">
                <input
                  id="terms"
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="size-4 rounded-sm border-neutral-700 bg-[#18191d] text-[#5C6BC0] focus:ring-[#5C6BC0] accent-[#5C6BC0]"
                />
                <label htmlFor="terms" className="text-xs text-neutral-300 select-none cursor-pointer">
                  I accept the{' '}
                  <a href="/terms" target="_blank" className="text-[#5C6BC0] hover:underline font-medium">
                    terms and conditions
                  </a>
                  .
                </label>
              </div>

              <div className="border-t border-neutral-700/60 w-full" />

              {/* Submit button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-1.5 px-2.5 rounded-md bg-[#5C6BC0] hover:bg-[#4D5CB5] active:bg-[#3F4EA3] text-white font-medium text-sm transition-colors shadow-sm cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Signing Up...' : 'Sign Up'}
              </button>
            </form>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
