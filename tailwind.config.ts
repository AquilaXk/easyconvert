import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;
const radius = (steps: number) => `calc(var(--radius-unit) * ${steps})`;

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      inherit: "inherit",
      canvas: token("canvas"),
      surface: token("surface"),
      sunken: token("sunken"),
      ink: { DEFAULT: token("ink"), 2: token("ink-2"), 3: token("ink-3") },
      "on-accent": token("on-accent"),
      rule: { DEFAULT: token("rule"), strong: token("rule-strong") },
      accent: {
        DEFAULT: token("accent"),
        hover: token("accent-hover"),
        press: token("accent-press"),
        ink: token("accent-ink"),
        soft: token("accent-soft"),
        edge: token("accent-edge"),
      },
      success: { DEFAULT: token("success"), soft: token("success-soft"), edge: token("success-edge") },
      warning: { DEFAULT: token("warning"), soft: token("warning-soft"), edge: token("warning-edge") },
      danger: { DEFAULT: token("danger"), soft: token("danger-soft"), edge: token("danger-edge") },
      info: { DEFAULT: token("info"), soft: token("info-soft"), edge: token("info-edge") },
    },
    borderRadius: {
      none: "0",
      xs: radius(0.5),
      sm: radius(1),
      md: radius(1.5),
      xl: radius(3),
      full: "9999px",
    },
    boxShadow: {
      none: "none",
      "elev-1": "var(--elev-1)",
      "elev-2": "var(--elev-2)",
      glow: "var(--glow)",
      float: "var(--elev-2), var(--glow)",
    },
    extend: {
      maxWidth: {
        "8xl": "90rem",
      },
      fontFamily: {
        sans: ["var(--font-ui)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
      },
      transitionTimingFunction: {
        spring: "var(--ease-spring)",
      },
    },
  },
  plugins: [],
};

export default config;
