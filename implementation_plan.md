# Implementation Plan: Modern Converter UI Redesign (Free Static & Ad-Monetized)

## Objective
Modernize EasyConvert's user interface to provide a clean, high-conversion, intuitive file conversion experience tailored for 100% free static deployment. Completely eliminate obsolete pricing and server-dependent API docs/navigation, introduce responsive ad slot placeholders, and upgrade the visual hierarchy with our signature Lavender brand palette.

---

## Phase Breakdown

### Phase 1: Deprecate Obsolete Pricing & API Pages/Navigation
- Delete `src/app/pricing/page.tsx` and `src/app/api/v2/page.tsx`.
- Refactor `src/components/Header.tsx`:
  - Remove API mega-menu dropdown and its state (`isApiOpen`).
  - Remove Pricing links from desktop and mobile navigation.
  - Retain Tools mega-menu, theme toggle, and auth controls.
- Refactor `src/components/Footer.tsx`:
  - Remove `/pricing` and `/api/v2` links.
  - Update Resources column to link to format catalog, how-it-works, and privacy/security.
- Refactor `src/components/Features.tsx`:
  - Remove "API & Integrations" code block and credit pricing mentions.
- Refactor `src/components/FaqSection.tsx`:
  - Eliminate references to enterprise paid API tiers; focus on 100% free, browser-edge processing.

### Phase 2: Implement Responsive Ad Banner Component System
- Create `src/components/AdBanner.tsx`:
  - Support ad slot types:
    - `top-leaderboard`: 728x90 (desktop) / 320x50 (mobile) banner below header.
    - `mid-content`: 728x90 responsive banner between hero dropzone and feature section.
    - `in-feed`: Responsive display ad between feature highlights and FAQ.
    - `post-conversion`: High-visibility placement adjacent to conversion queue results.
  - Standardized aesthetic container with subtle neutral borders, muted "ADVERTISEMENT" badge, and clean fallback ready for Google AdSense / display ad network scripts.

### Phase 3: Modernize Hero & Dropzone with Signature Palette
- Upgrade `src/components/Hero.tsx`:
  - Modernized dropzone container with clean padding, dashed active drag state, and prominent signature Lavender CTA button (`#5C6BC0`).
  - Add quick converter category pills above/below the dropzone (`All`, `PDF to Word`, `Image Converter`, `Video to MP3`, `Compress PDF`, `Audio`, `E-Book`).
  - Integrate a streamlined format pair switcher with signature orbit animations and smooth card flips.
  - Highlight 100% Free & Client-Side Edge badges: "100% Free • No Sign-up Required • Up to 1GB • Zero Cloud Retention".

### Phase 4: Upgrade Features, 3-Step Guide, and FAQ Integration
- In `src/components/Features.tsx`:
  - Add a 3-step visual conversion workflow:
    1. Upload File (Drag & drop or browse)
    2. Choose Output Format (290+ supported formats)
    3. Download Instantly (Zero watermarks, instant edge rendering)
  - Retain and polish the format catalog with category filtering and common conversion shortcuts.
- In `src/app/page.tsx`:
  - Integrate `AdBanner` at top leaderboard, mid-content, in-feed, and post-conversion slots.
  - Embed `FaqSection` directly into the home page for SEO and user clarity.

### Phase 5: Verification, Build Testing & Screenshot Artifact Generation
- Run full Vitest suite (`npm test`).
- Run production static build (`npm run build`).
- Validate responsive design and generate UI preview artifact screenshots.
