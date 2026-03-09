import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        "background-secondary": "var(--background-secondary)",
        foreground: "var(--foreground)",
        "foreground-secondary": "var(--foreground-secondary)",
        "foreground-muted": "var(--foreground-muted)",
        "accent-start": "var(--accent-start)",
        "accent-end": "var(--accent-end)",
        "card-bg": "var(--card-bg)",
        "card-border": "var(--card-border)",
        // Subway line colors
        "line-blue": "#3b82f6",
        "line-emerald": "#10b981",
        "line-orange": "#f97316",
        "line-violet": "#8b5cf6",
      },
      animation: {
        "draw-line": "draw-line 1.5s ease-out forwards",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "fade-in-up": "fade-in-up 0.4s ease-out forwards",
      },
      keyframes: {
        "draw-line": {
          "0%": { strokeDashoffset: "var(--path-length, 2000)" },
          "100%": { strokeDashoffset: "0" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.8", transform: "scale(1.05)" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;

