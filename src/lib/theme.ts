/**
 * Signature Lavender Design System
 * Carefully calibrated for high contrast, accessibility, and elegance.
 */
export const LAVENDER_PALETTE = {
  brand: {
    50: '#F8F9FE',
    100: '#F0F2FD',
    200: '#E2E5FD',
    300: '#CCD2FC',
    400: '#8E9CE6',
    500: '#5C6BC0', // Primary interaction / Signature Lavender
    600: '#4D5CB5', // Hover
    700: '#3F4EA3', // Active
    800: '#333F85',
    900: '#262F64',
    950: '#171C3D',
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

export const BRAND_PALETTE = LAVENDER_PALETTE;
