import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      maxWidth: {
        '8xl': '90rem',
      },
      colors: {
        brand: {
          50: "#F8F9FF",
          100: "#F0F2FE",
          200: "#E2E5FD",
          300: "#CCD2FC",
          400: "#B4BCFB",
          500: "#8E9CE6",
          600: "#7480D2",
          700: "#5C6BC0", // Main signature accent (primary CTA button fill, main interaction, focus ring)
          800: "#4A58A9", // Main CTA button pressed state
          900: "#3B4890", // Signature surface text/border/focus
          950: "#1F2340", // Content primary body text
        },
        primary: {
          DEFAULT: "#5C6BC0",
          hover: "#4A58A9",
          active: "#3B4890",
          50: "#F8F9FF",
          100: "#F0F2FE",
          200: "#E2E5FD",
          300: "#CCD2FC",
          400: "#B4BCFB",
          500: "#8E9CE6",
          600: "#7480D2",
          700: "#5C6BC0",
          800: "#4A58A9",
          900: "#3B4890",
        },
        neutral: {
          white: "#FFFFFF",
          scaffold: "#F7F8FC",
          subtle: "#F0F2F7",
          border: "#E1E4EE",
        },
        ink: {
          primary: "#1F2340",
          secondary: "#4D536B",
          muted: "#697089",
        },
        status: {
          success: "#0A705A",
          warning: "#9A5600",
          danger: "#D9383A",
          info: "#215EA8",
          successSoft: "#F0FBF7",
          warningSoft: "#FFF0D1",
          dangerSoft: "#FEE2E2",
          infoSoft: "#EEF5FF",
        },
        dark: {
          scaffold: "#141724", // Dark Indigo-Tinted Charcoal Scaffold
          surface: "#1B2032",  // Elevated Card
          elevated: "#242B42",
          border: "#2C3452",
          text: "#F8F9FD",
          muted: "#8A94B8",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
      },
      animation: {
        "orbit-slow": "orbit-spin 90s linear infinite",
        "orbit-fast": "orbit-spin 60s linear infinite reverse",
        "spin-pulse": "spin-pulse 3s ease-in-out infinite",
        "arrow-sweep": "arrow-sweep 2.4s ease-in-out infinite",
        "output-pulse": "output-pulse 3s ease-in-out infinite",
        "card-flip": "card-flip 0.45s cubic-bezier(0.34, 1.4, 0.6, 1) both",
      },
      keyframes: {
        "orbit-spin": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "spin-pulse": {
          "0%, 100%": { opacity: "0.85", transform: "rotate(0deg)" },
          "50%": { opacity: "1", transform: "rotate(180deg)" },
        },
        "arrow-sweep": {
          "0%, 100%": { opacity: "0", transform: "translateX(-100%)" },
          "50%": { opacity: "1", transform: "translateX(100%)" },
        },
        "output-pulse": {
          "0%, 100%": {
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 32px rgba(92, 107, 192, 0.22)",
          },
          "50%": {
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 38px rgba(92, 107, 192, 0.38)",
          },
        },
        "card-flip": {
          "0%": { opacity: "0", transform: "rotateX(-70deg) translateY(8px)" },
          "100%": { opacity: "1", transform: "rotateX(0deg) translateY(0px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
