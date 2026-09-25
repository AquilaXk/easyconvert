'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useRouter } from 'next/navigation';
import { Lock, Mail, Eye, EyeOff, Shield, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [emailOrUser, setEmailOrUser] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
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
    <div className="flex flex-col min-h-screen bg-[#141414] text-white">
      <Header />

      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-16">
        <div className="w-full max-w-[460px] bg-[#1e1e1e] border border-neutral-800 rounded-2xl p-8 sm:p-10 shadow-2xl animate-in fade-in duration-200">
          {/* Card Header */}
          <div className="text-center mb-7">
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Login</h1>
            <p className="mt-2 text-sm text-neutral-400">
              Don&apos;t have an account?{' '}
              <a
                href="/register"
                className="text-[#5C6BC0] hover:text-[#7986CB] font-medium transition-colors"
              >
                Sign up
              </a>
              .
            </p>
          </div>

          {/* Social Logins */}
          <div className="space-y-2.5 mb-6">
            <button
              type="button"
              onClick={() => handleSocialLogin('Google')}
              className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700/80 text-sm font-medium text-neutral-200 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Google</span>
            </button>

            <button
              type="button"
              onClick={() => handleSocialLogin('Facebook')}
              className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700/80 text-sm font-medium text-neutral-200 transition-colors"
            >
              <svg className="w-4 h-4 fill-current text-[#1877F2]" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
              <span>Facebook</span>
            </button>

            <button
              type="button"
              onClick={() => handleSocialLogin('Twitter')}
              className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700/80 text-sm font-medium text-neutral-200 transition-colors"
            >
              <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              <span>Twitter</span>
            </button>

            <button
              type="button"
              onClick={() => handleSocialLogin('SSO')}
              className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700/80 text-sm font-medium text-neutral-200 transition-colors"
            >
              <Lock className="w-4 h-4 text-neutral-400" />
              <span>SSO</span>
            </button>
          </div>

          {/* Divider */}
          <div className="relative flex items-center justify-center my-6">
            <div className="border-t border-neutral-800 w-full" />
            <span className="bg-[#1e1e1e] px-3 text-xs text-neutral-500 uppercase tracking-wider font-semibold">
              or
            </span>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="emailOrUser"
                className="block text-xs font-semibold text-neutral-300 mb-1.5"
              >
                Email or Username
              </label>
              <input
                id="emailOrUser"
                type="text"
                required
                value={emailOrUser}
                onChange={(e) => setEmailOrUser(e.target.value)}
                placeholder="name@example.com"
                className="w-full px-3.5 py-2.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] focus:border-transparent transition-all"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label
                  htmlFor="loginPassword"
                  className="block text-xs font-semibold text-neutral-300"
                >
                  Password
                </label>
                <a
                  href="/forgot-password"
                  className="text-xs text-[#5C6BC0] hover:text-[#7986CB] transition-colors"
                >
                  Forgot password?
                </a>
              </div>
              <div className="relative">
                <input
                  id="loginPassword"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3.5 py-2.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5C6BC0] focus:border-transparent transition-all pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                id="remember"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-[#5C6BC0] focus:ring-[#5C6BC0]"
              />
              <label htmlFor="remember" className="text-xs text-neutral-400 select-none cursor-pointer">
                Remember me on this device
              </label>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-3 py-2.5 px-4 rounded-lg bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] text-white font-semibold text-sm shadow-md transition-all flex items-center justify-center gap-2"
            >
              {loading ? <span>Signing in...</span> : <span>Continue</span>}
            </button>
          </form>
        </div>
      </main>

      <Footer />
    </div>
  );
}
