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
          50: "#F8F9FE",
          100: "#F0F2FD",
          200: "#E2E5FD",
          300: "#CCD2FC",
          400: "#8E9CE6",
          500: "#5C6BC0", // Signature Lavender
          600: "#4D5CB5", // Hover
          700: "#3F4EA3", // Active
          800: "#333F85",
          900: "#262F64",
          950: "#171C3D",
        },
        primary: {
          DEFAULT: "#5C6BC0",
          hover: "#4D5CB5",
          50: "#F8F9FE",
          100: "#F0F2FD",
          200: "#E2E5FD",
          300: "#CCD2FC",
          400: "#8E9CE6",
          500: "#5C6BC0",
          600: "#4D5CB5",
          700: "#3F4EA3",
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
          scaffold: "#18191D", // Dark Neutral Charcoal Scaffold
          surface: "#212529",  // Elevated Card
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
