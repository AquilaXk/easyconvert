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
      colors: {
        brand: {
          50: "#F8F9FF",
          100: "#F0F2FE",
          200: "#E2E5FD",
          300: "#CCD2FC",
          400: "#B4BCFB",
          500: "#949FE8",
          600: "#7480D2",
          700: "#5C6BC0",
          800: "#4A58A9",
          900: "#3B4890",
          950: "#1F2340",
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
          danger: "#B42318",
          info: "#215EA8",
          successSoft: "#F0FBF7",
          warningSoft: "#FFF0D1",
          dangerSoft: "#FFE8E6",
          infoSoft: "#EEF5FF",
        },
        dark: {
          scaffold: "#0D0F1A",
          surface: "#141829",
          elevated: "#1C223A",
          border: "#273052",
          text: "#F8F9FF",
          muted: "#8B95B8",
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
    },
  },
  plugins: [],
};

export default config;
