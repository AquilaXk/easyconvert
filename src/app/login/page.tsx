'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useRouter } from 'next/navigation';
export default function LoginPage() {
  const router = useRouter();
  const [emailOrUser, setEmailOrUser] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailOrUser.trim() || !password.trim()) {
      setError('Please provide both username/email and password.');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await new Promise((r) => setTimeout(r, 400));
      localStorage.setItem('easyconvert_user', emailOrUser.trim());
      router.push('/');
    } catch {
      setError('An error occurred during authentication.');
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = (provider: string) => {
    localStorage.setItem('easyconvert_user', `user@${provider.toLowerCase()}.com`);
    router.push('/');
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#18191d] text-white">
      <Header />

      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="w-full max-w-md rounded-none bg-[#212529]/50 ring-1 ring-neutral-700/80 shadow-2xl p-4 sm:p-6 animate-in fade-in duration-200">
          {/* Header */}
          <div className="flex flex-col text-center mb-6">
            <h1 className="text-xl font-semibold text-white tracking-tight">Login</h1>
            <p className="mt-1 text-base text-neutral-400">
              Don&apos;t have an account?{' '}
              <a href="/register" className="text-[#d9383a] hover:underline font-medium">
                Sign up
              </a>
              .
            </p>
          </div>

          <div className="flex flex-col gap-y-6">
            {/* 4 Social Login Buttons */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => handleSocialLogin('Google')}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md ring-1 ring-inset ring-neutral-700 bg-[#212529] hover:bg-neutral-800 text-neutral-200 transition-colors cursor-pointer"
              >
                <svg className="size-4 shrink-0 fill-current" viewBox="0 0 512 512">
                  <path d="M500 261.8C500 403.3 403.1 504 260 504 122.8 504 12 393.2 12 256S122.8 8 260 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9c-88.3-85.2-252.5-21.2-252.5 118.2 0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9l-140.8 0 0-85.3 236.1 0c2.3 12.7 3.9 24.9 3.9 41.4z" />
                </svg>
                <span>Google</span>
              </button>

              <button
                type="button"
                onClick={() => handleSocialLogin('Facebook')}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md ring-1 ring-inset ring-neutral-700 bg-[#212529] hover:bg-neutral-800 text-neutral-200 transition-colors cursor-pointer"
              >
                <svg className="size-4 shrink-0 fill-current" viewBox="0 0 512 512">
                  <path d="M512 256C512 114.6 397.4 0 256 0S0 114.6 0 256C0 376 82.7 476.8 194.2 504.5l0-170.3-52.8 0 0-78.2 52.8 0 0-33.7c0-87.1 39.4-127.5 125-127.5 16.2 0 44.2 3.2 55.7 6.4l0 70.8c-6-.6-16.5-1-29.6-1-42 0-58.2 15.9-58.2 57.2l0 27.8 83.6 0-14.4 78.2-69.3 0 0 175.9C413.8 494.8 512 386.9 512 256z" />
                </svg>
                <span>Facebook</span>
              </button>

              <button
                type="button"
                onClick={() => handleSocialLogin('Twitter')}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md ring-1 ring-inset ring-neutral-700 bg-[#212529] hover:bg-neutral-800 text-neutral-200 transition-colors cursor-pointer"
              >
                <svg className="size-4 shrink-0 fill-current" viewBox="0 0 512 512">
                  <path d="M459.4 151.7c.3 4.5 .3 9.1 .3 13.6 0 138.7-105.6 298.6-298.6 298.6-59.5 0-114.7-17.2-161.1-47.1 8.4 1 16.6 1.3 25.3 1.3 49.1 0 94.2-16.6 130.3-44.8-46.1-1-84.8-31.2-98.1-72.8 6.5 1 13 1.6 19.8 1.6 9.4 0 18.8-1.3 27.6-3.6-48.1-9.7-84.1-52-84.1-103l0-1.3c14 7.8 30.2 12.7 47.4 13.3-28.3-18.8-46.8-51-46.8-87.4 0-19.5 5.2-37.4 14.3-53 51.7 63.7 129.3 105.3 216.4 109.8-1.6-7.8-2.6-15.9-2.6-24 0-57.8 46.8-104.9 104.9-104.9 30.2 0 57.5 12.7 76.7 33.1 23.7-4.5 46.5-13.3 66.6-25.3-7.8 24.4-24.4 44.8-46.1 57.8 21.1-2.3 41.6-8.1 60.4-16.2-14.3 20.8-32.2 39.3-52.6 54.3z" />
                </svg>
                <span>Twitter</span>
              </button>

              <button
                type="button"
                onClick={() => handleSocialLogin('SSO')}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md ring-1 ring-inset ring-neutral-700 bg-[#212529] hover:bg-neutral-800 text-neutral-200 transition-colors cursor-pointer"
              >
                <svg className="size-4 shrink-0 fill-current" viewBox="0 0 384 512">
                  <path d="M64 0C28.7 0 0 28.7 0 64L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-384c0-35.3-28.7-64-64-64L64 0zM176 352l32 0c17.7 0 32 14.3 32 32l0 80-96 0 0-80c0-17.7 14.3-32 32-32zM96 112c0-8.8 7.2-16 16-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32zM240 96l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32c0-8.8 7.2-16 16-16zM96 240c0-8.8 7.2-16 16-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32zm144-16l32 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-32 0c-8.8 0-16-7.2-16-16l0-32c0-8.8 7.2-16 16-16z" />
                </svg>
                <span>SSO</span>
              </button>
            </div>

            {/* Separator */}
            <div className="flex items-center align-center text-center w-full">
              <div className="border-neutral-700 w-full border-t" />
              <span className="font-medium text-neutral-400 text-sm mx-3">or</span>
              <div className="border-neutral-700 w-full border-t" />
            </div>

            {/* Form with empty inputs (no placeholders) */}
            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="p-2.5 rounded bg-red-950/50 border border-red-500/50 text-red-300 text-xs">
                  {error}
                </div>
              )}

              <div className="text-sm">
                <label htmlFor="loginEmail" className="block font-medium text-neutral-300 mb-1">
                  Email or Username
                </label>
                <input
                  id="loginEmail"
                  type="text"
                  name="email"
                  required
                  value={emailOrUser}
                  onChange={(e) => setEmailOrUser(e.target.value)}
                  className="w-full rounded-md border-0 bg-[#18191d] ring-1 ring-inset ring-neutral-700/80 focus:ring-1 focus:ring-[#d9383a] px-2.5 py-1.5 text-sm text-white outline-none transition-colors"
                />
              </div>

              <div className="text-sm">
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="loginPassword" className="block font-medium text-neutral-300">
                    Password
                  </label>
                  <a href="/forgot-password" className="text-[#d9383a] hover:underline font-medium text-xs">
                    Forgot password?
                  </a>
                </div>
                <input
                  id="loginPassword"
                  type="password"
                  name="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border-0 bg-[#18191d] ring-1 ring-inset ring-neutral-700/80 focus:ring-1 focus:ring-[#d9383a] px-2.5 py-1.5 text-sm text-white outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="rounded-md font-medium text-sm py-1.5 px-2.5 w-full justify-center text-white bg-[#d9383a] hover:bg-[#c22e30] active:bg-[#a82325] transition-colors shadow-sm cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Continuing...' : 'Continue'}
              </button>
            </form>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
