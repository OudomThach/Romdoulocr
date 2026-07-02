/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  blocklist: ['[-:=\\s]'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // `ink` is mapped to CSS variables (defined in index.css) so the older
        // "dark panel" components theme correctly: the scale is reversed in
        // light mode and natural in dark mode. See index.css for the rationale.
        ink: {
          50: 'rgb(var(--c-ink-50) / <alpha-value>)',
          100: 'rgb(var(--c-ink-100) / <alpha-value>)',
          200: 'rgb(var(--c-ink-200) / <alpha-value>)',
          300: 'rgb(var(--c-ink-300) / <alpha-value>)',
          400: 'rgb(var(--c-ink-400) / <alpha-value>)',
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',
          600: 'rgb(var(--c-ink-600) / <alpha-value>)',
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',
          800: 'rgb(var(--c-ink-800) / <alpha-value>)',
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
          950: 'rgb(var(--c-ink-950) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
        },
        // Secondary accent (jade in dark) — pairs with the gold `accent` for the
        // cyberpunk theme. Mapped to a CSS variable like the rest.
        accent2: 'rgb(var(--c-accent-2) / <alpha-value>)',
        // `white` and the `slate` scale are mapped to CSS variables so the
        // entire app can switch between light and dark by toggling a single
        // `.dark` class on <html>. The variables are defined in index.css.
        // Every existing `bg-white`, `text-slate-950`, `border-slate-200`,
        // and opacity modifier (bg-white/90) themes automatically — no
        // component edits required.
        white: 'rgb(var(--c-white) / <alpha-value>)',
        slate: {
          50: 'rgb(var(--c-slate-50) / <alpha-value>)',
          100: 'rgb(var(--c-slate-100) / <alpha-value>)',
          200: 'rgb(var(--c-slate-200) / <alpha-value>)',
          300: 'rgb(var(--c-slate-300) / <alpha-value>)',
          400: 'rgb(var(--c-slate-400) / <alpha-value>)',
          500: 'rgb(var(--c-slate-500) / <alpha-value>)',
          600: 'rgb(var(--c-slate-600) / <alpha-value>)',
          700: 'rgb(var(--c-slate-700) / <alpha-value>)',
          800: 'rgb(var(--c-slate-800) / <alpha-value>)',
          900: 'rgb(var(--c-slate-900) / <alpha-value>)',
          950: 'rgb(var(--c-slate-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
