/**
 * CloudConvert-Matched Design System Palette
 * Red CTA palette with dark neutral charcoal.
 */
export const BRAND_PALETTE = {
  brand: {
    50: '#FEF2F2',
    100: '#FEE2E2',
    200: '#FECACA',
    300: '#FCA5A5',
    400: '#F87171',
    500: '#D9383A', // Primary CTA Red
    600: '#C22E30', // Hover
    700: '#A82325', // Active
    800: '#8C1B1D',
    900: '#701617',
    950: '#450A0B',
  },
  neutral: {
    white: '#FFFFFF',
    scaffold: '#F7F8FC',
    subtle: '#F0F2F7',
    border: '#E1E4EE',
  },
  ink: {
    primary: '#18191D',
    secondary: '#4D536B',
    muted: '#697089',
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
    scaffold: '#18191D',
    surface: '#212529',
    elevated: '#2A2E33',
    border: '#343A40',
    text: '#F8F9FA',
    muted: '#9CA3AF',
  },
} as const;

export const LAVENDER_PALETTE = BRAND_PALETTE;
