import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a1a3f",
        muted: "#64748b",
        paper: "#f7f8fb",
        panel: "#ffffff",
        line: "#e4e9f5",
        accent: "#059669",
        warning: "#b45309",
        danger: "#b91c1c"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "monospace"]
      },
      boxShadow: {
        subtle: "0 8px 24px rgba(10, 26, 63, 0.08)"
      }
    }
  },
  plugins: []
} satisfies Config;
