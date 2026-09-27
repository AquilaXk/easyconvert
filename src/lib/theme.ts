/**
 * EasyConvert Brand Signature Palette & Design Tokens
 * Calibrated for high contrast, accessibility, and modern elegance.
 */
export const BRAND_PALETTE = {
  brand: {
    50: '#F8F9FF',   // Top bar (Chrome) surface
    100: '#F0F2FE',  // Secondary button background, light brand surface
    200: '#E2E5FD',  // Secondary button pressed state background
    300: '#CCD2FC',  // Decorative divider
    400: '#B4BCFB',  // Signature surface (onboarding highlight, indicator)
    500: '#8E9CE6',  // Medium accent bridge
    600: '#7480D2',  // Secondary button border
    700: '#5C6BC0',  // Main signature accent (primary CTA button fill, main interaction, focus ring)
    800: '#4A58A9',  // Main CTA button pressed state
    900: '#3B4890',  // Text/border/focus on signature surface
    950: '#1F2340',  // Content primary body text
  },
  neutral: {
    white: '#FFFFFF',     // Surface default
    scaffold: '#F7F8FC',  // Surface scaffold
    subtle: '#F0F2F7',    // Surface subtle (search bar / sub panel)
    border: '#E1E4EE',    // Border subtle (divider / thin border)
  },
  ink: {
    primary: '#1F2340',   // Content primary (brand.950)
    secondary: '#4D536B', // Content secondary
    muted: '#697089',     // Content muted
  },
  status: {
    success: '#0A705A',
    warning: '#9A5600',
    danger: '#D9383A',
    info: '#215EA8',
    successSoft: '#F0FBF7',
    warningSoft: '#FFF0D1',
    dangerSoft: '#FEE2E2',
    infoSoft: '#EEF5FF',
  },
  dark: {
    scaffold: '#141724',  // Dark blue-tinted scaffold
    surface: '#1B2032',   // Elevated dark card
    elevated: '#242B42',
    border: '#2C3452',
    text: '#F8F9FD',
    muted: '#8A94B8',
  },
} as const;

export const LAVENDER_PALETTE = BRAND_PALETTE;
