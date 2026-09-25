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
          50: "#FEF2F2",
          100: "#FEE2E2",
          200: "#FECACA",
          300: "#FCA5A5",
          400: "#F87171",
          500: "#D9383A", // CloudConvert Primary Red
          600: "#C22E30", // Hover
          700: "#A82325", // Active
          800: "#8C1B1D",
          900: "#701617",
          950: "#450A0B",
        },
        primary: {
          DEFAULT: "#D9383A",
          hover: "#C22E30",
          50: "#FEF2F2",
          100: "#FEE2E2",
          200: "#FECACA",
          300: "#FCA5A5",
          400: "#F87171",
          500: "#D9383A",
          600: "#C22E30",
          700: "#A82325",
        },
        neutral: {
          white: "#FFFFFF",
          scaffold: "#F7F8FC",
          subtle: "#F0F2F7",
          border: "#E1E4EE",
        },
        ink: {
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
          scaffold: "#18191D", // CloudConvert Dark Neutral Charcoal
          surface: "#212529",  // CloudConvert Card / Elevated
          elevated: "#2A2E33",
          border: "#343A40",
          text: "#F8F9FA",
          muted: "#9CA3AF",
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
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 32px rgba(190, 50, 50, 0.18)",
          },
          "50%": {
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 38px rgba(220, 80, 80, 0.32)",
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
