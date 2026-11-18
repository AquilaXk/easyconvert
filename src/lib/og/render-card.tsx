import React from 'react';
import { ImageResponse } from 'next/og';
import { loadOgFonts } from './fonts';
import type { OgCardSpec } from './resolve-card';

/**
 * 1200x630 OpenGraph / Twitter (`summary_large_image`) / KakaoTalk social preview card renderer.
 *
 * Layout and visual hierarchy follow high-star `vercel/satori` (`next/og`) production card
 * architectures (`dubinc/dub` `apps/web/app/api/og`, `shadcn-ui/ui` `apps/v4/app/og/route.tsx`)
 * paired with the format-bridge pill motif of reference file-conversion services:
 *  - Exact `1200x630` canvas with a `1080x510` inner safe frame (`padding: 56px 60px`) so X/Twitter's
 *    `2:1` vertical crop and KakaoTalk's rounded preview container clip zero glyphs or badges.
 *  - Authentic rounded-squircle prism mark (`rx="106.96"`, identical SVG geometry and gradient stops
 *    to `src/components/BrandLogo.tsx`).
 */

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

const DOCUMENT_PATH =
  'M 170.30 127.57 A 12.37 12.37 0 0 1 179.05 123.94 L 236.14 123.94 A 19.11 19.11 0 0 1 255.25 143.06 L 255.25 352.94 A 19.11 19.11 0 0 1 236.14 372.05 L 145.82 372.05 A 19.11 19.11 0 0 1 126.70 352.94 L 126.70 176.29 A 12.37 12.37 0 0 1 130.32 167.54 Z';
const CHEVRON_PATH =
  'M 283.36 126.84 A 1.20 1.20 0 0 1 285.41 125.99 L 405.71 246.52 A 2.10 2.10 0 0 1 405.71 249.48 L 285.41 370.00 A 1.20 1.20 0 0 1 283.36 369.15 L 283.36 293.41 A 1.05 1.05 0 0 1 283.67 292.67 L 327.17 249.16 A 1.65 1.65 0 0 0 327.17 246.83 L 283.67 203.33 A 1.05 1.05 0 0 1 283.36 202.59 Z';
const BEVEL_PATH = 'M 281.86 122.44 L 337.71 248.00 L 281.86 373.55 L 280.37 373.55 L 280.37 122.44 Z';

function headlineFontSize(headline: string, hasFormatBridge: boolean): number {
  const len = headline.length;
  if (hasFormatBridge) {
    if (len <= 20) return 56;
    if (len <= 32) return 48;
    return 42;
  }
  if (len <= 20) return 62;
  if (len <= 32) return 52;
  return 44;
}

function BrandPrismSvg({ size }: Readonly<{ size: number }>) {
  return (
    <svg width={size} height={size} viewBox="36 28 440 440" fill="none">
      <defs>
        <linearGradient id="og-tile" x1="52.49" y1="40.74" x2="464.76" y2="456.76" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2664EB" />
          <stop offset="26%" stopColor="#2952D8" />
          <stop offset="52%" stopColor="#332699" />
          <stop offset="80%" stopColor="#6D2DCB" />
          <stop offset="100%" stopColor="#8D31E3" />
        </linearGradient>
        <linearGradient id="og-face" x1="341.08" y1="128.44" x2="326.09" y2="368.31" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8AF4FF" />
          <stop offset="52%" stopColor="#76DFFE" />
          <stop offset="100%" stopColor="#2FB3FA" />
        </linearGradient>
        <linearGradient id="og-bevel" x1="296.86" y1="128.44" x2="296.86" y2="366.81" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1EB7F8" />
          <stop offset="50%" stopColor="#55CEFD" />
          <stop offset="100%" stopColor="#8DF3FE" />
        </linearGradient>
        <clipPath id="og-chevron">
          <path d={CHEVRON_PATH} />
        </clipPath>
      </defs>
      <rect x="36" y="28" width="440" height="440" rx="106.96" fill="url(#og-tile)" />
      <path d={DOCUMENT_PATH} fill="#FFFFFF" />
      <g clipPath="url(#og-chevron)">
        <path d={CHEVRON_PATH} fill="url(#og-face)" />
        <path d={BEVEL_PATH} fill="url(#og-bevel)" />
      </g>
    </svg>
  );
}

function FormatBridge({ sourceBadge, targetBadge }: Readonly<{ sourceBadge: string; targetBadge?: string }>) {
  if (!targetBadge) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 22,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 22px',
            borderRadius: 14,
            background: 'rgba(37, 99, 235, 0.18)',
            border: '1px solid rgba(96, 165, 250, 0.42)',
            color: '#93C5FD',
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: '#38BDF8',
            }}
          />
          <span>.{sourceBadge}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 26px',
          borderRadius: 16,
          background: 'rgba(15, 23, 42, 0.88)',
          border: '1.5px solid rgba(148, 163, 184, 0.34)',
          color: '#F1F5F9',
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: '#60A5FA',
          }}
        />
        <span>{sourceBadge}</span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 52,
          height: 52,
          borderRadius: 999,
          background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.32) 0%, rgba(141, 49, 227, 0.32) 100%)',
          border: '1px solid rgba(125, 211, 252, 0.4)',
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 12H19M19 12L13 6M19 12L13 18"
            stroke="#7DD3FC"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 28px',
          borderRadius: 16,
          background: 'linear-gradient(135deg, rgba(38, 100, 235, 0.32) 0%, rgba(109, 45, 203, 0.36) 100%)',
          border: '1.5px solid rgba(125, 211, 252, 0.55)',
          color: '#FFFFFF',
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: '#38BDF8',
          }}
        />
        <span>{targetBadge}</span>
      </div>
    </div>
  );
}

function OgCardCanvas({ spec }: Readonly<{ spec: OgCardSpec }>) {
  const hasBridge = Boolean(spec.sourceBadge);
  const titleSize = headlineFontSize(spec.headline, hasBridge);

  return (
    <div
      style={{
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        display: 'flex',
        position: 'relative',
        backgroundColor: '#070B14',
        backgroundImage:
          'radial-gradient(circle at 14% 16%, rgba(38, 100, 235, 0.28) 0%, rgba(7, 11, 20, 0) 52%), radial-gradient(circle at 88% 82%, rgba(141, 49, 227, 0.24) 0%, rgba(7, 11, 20, 0) 54%)',
        padding: '44px 52px',
        fontFamily: '"EasyConvert Sans"',
        color: '#F8FAFC',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRadius: 28,
          padding: '44px 52px',
          background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.82) 0%, rgba(9, 14, 26, 0.92) 100%)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.45)',
        }}
      >
        {/* Top brand & eyebrow row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <BrandPrismSvg size={48} />
            <span
              style={{
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: '#FFFFFF',
              }}
            >
              EasyConvert
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 18px',
              borderRadius: 999,
              background: 'rgba(30, 41, 59, 0.85)',
              border: '1px solid rgba(148, 163, 184, 0.24)',
              color: '#BAE6FD',
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: '0.06em',
            }}
          >
            {spec.eyebrow}
          </div>
        </div>

        {/* Center hero block */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            marginTop: 8,
            marginBottom: 8,
          }}
        >
          {spec.sourceBadge ? (
            <FormatBridge sourceBadge={spec.sourceBadge} targetBadge={spec.targetBadge} />
          ) : null}

          <div
            style={{
              display: 'flex',
              fontSize: titleSize,
              fontWeight: 700,
              lineHeight: 1.16,
              letterSpacing: '-0.025em',
              color: '#FFFFFF',
              marginBottom: 18,
            }}
          >
            {spec.headline}
          </div>

          <div
            style={{
              display: 'flex',
              fontSize: 25,
              fontWeight: 400,
              lineHeight: 1.48,
              color: '#94A3B8',
              maxWidth: 960,
              wordBreak: spec.locale === 'ko' ? 'keep-all' : 'normal',
            }}
          >
            {spec.description}
          </div>

          {spec.pills && spec.pills.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24 }}>
              {spec.pills.map((pill) => (
                <div
                  key={pill}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '7px 16px',
                    borderRadius: 10,
                    background: 'rgba(30, 41, 59, 0.72)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    color: '#CBD5E1',
                    fontSize: 17,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                  }}
                >
                  {pill}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Bottom footer bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 22,
            borderTop: '1px solid rgba(148, 163, 184, 0.14)',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 9,
                height: 9,
                borderRadius: 999,
                background: '#34D399',
              }}
            />
            <span style={{ fontSize: 21, fontWeight: 700, color: '#E2E8F0', letterSpacing: '-0.01em' }}>
              convert.aquilaxk.site
            </span>
          </div>

          <span style={{ fontSize: 20, fontWeight: 400, color: '#94A3B8' }}>{spec.footerRight}</span>
        </div>
      </div>
    </div>
  );
}

export async function renderOgCardPng(spec: OgCardSpec): Promise<Uint8Array> {
  const fonts = await loadOgFonts();
  const response = new ImageResponse(<OgCardCanvas spec={spec} />, {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts,
  });
  return new Uint8Array(await response.arrayBuffer());
}
